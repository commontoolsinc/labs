# Memory v1 vs v2: Architecture Differences

This document summarizes the key architectural changes between the v1 and v2
memory systems. It is aimed at developers who know v1 and need to understand
what changed and why.

For the full v2 specification, see [README.md](./README.md).

---

## 1. Nursery/Heap vs Single Local State

### v1: Two-Tier Replica Cache

v1's `Replica` class maintains two separate in-memory stores:

- **Nursery** -- holds facts that have been committed locally but not yet
  confirmed by the server. Reads check nursery first.
- **Heap** -- holds facts confirmed by the server (or loaded from local IDB
  cache). Reads fall through to heap when nursery has no entry.

```
Replica.get(entry):
  nurseryState = this.nursery.get(entry)   // optimistic
  if nurseryState: return nurseryState
  heapState = this.heap.get(entry)         // confirmed
  return heapState
```

When a `commit()` succeeds, facts are promoted from nursery to heap via
`Nursery.evict()`. When it fails, facts are deleted from the nursery and a
"revert" notification is fired.

*(Source: `packages/runner/src/storage/cache.ts`, Nursery ~line 168,
Replica.get() ~line 1267)*

### v2: Single `localState` Map

v2's `ReplicaV2` has one map:

```
ReplicaV2.get(entry):
  return this.localState.get(entry.id)
```

There is no nursery because `transact()` is synchronous -- the commit is
validated and applied in one step. There is no "in-flight" window where local
state could diverge from confirmed state.

*(Source: `packages/runner/src/storage/v2/provider.ts`, ReplicaV2.get()
~line 130)*

### Why

The nursery/heap split exists to support optimistic concurrency: the client
writes locally (nursery), shows the user the optimistic result, then waits for
server confirmation. If the server rejects, the nursery entry is rolled back.
This creates complexity around promotion, eviction, and stale-detection
(`updateLocalFacts`, `pendingNurseryChanges`).

v2 avoids this entirely for the local provider. For a future remote provider,
the `reads.pending` field in `ClientCommit` will declare inter-commit
dependencies explicitly (see section 7), keeping the local state model simple.

---

## 2. Cause Chains vs Version Numbers

### v1: Content-Addressed Cause Chains

Each v1 fact carries a `cause` field that is the content hash (merkle reference)
of the previous fact for that entity. Writing A then B then C creates:

```
A.cause = hash(unclaimed{the, of})   // first write, no prior fact
B.cause = hash(A)                    // second write chains from A
C.cause = hash(B)                    // third write chains from B
```

The server validates by checking that the `cause` matches the current head.
If A is rejected by the server, B and C cascade-fail because their cause
references don't match what the server has.

This model has several gotchas:

- **Falsy `is` values**: `Fact.assert({cause: prevFact})` internally uses
  `cause.is ? { is: cause.is } : undefined`, which drops falsy values like
  `false`, `0`, `null`, and `""`. The workaround is `Fact.factReference(prevFact)`
  which checks `is !== undefined` instead.
- **Retraction as cause**: After retracting an entity, the retraction itself
  must be tracked as the `lastFact` so subsequent writes chain from it.
- **Batch deduplication**: When batching writes, entities must be deduplicated
  via Map to avoid double-writes with stale cause pointers.

*(Source: `packages/memory/fact.ts`, assert() ~line 32)*

### v2: Lamport Clock Versions

v2 uses monotonically increasing version numbers. Each commit gets a version.
The consumer tracks the version it last read for each entity:

```ts
// ConsumerSession.transact() builds confirmed reads from local cache
for (const entityId of readEntities) {
  const state = this.confirmed.get(`${branch}:${entityId}`);
  if (state) {
    confirmedReads.push({
      id: entityId,
      hash: state.hash,
      version: state.version,
    });
  }
}
```

Conflict detection is: "does the version I read still match the server's
head?" There is no cascading -- each entity's conflict is independent.

The `parent` field is **not sent on the wire**. Wire operations (`UserOperation`)
carry only `{ op, id, value/patches }` — no parent. The server resolves parent
from its own head state when constructing facts. This eliminates branded
`Reference` objects from the wire protocol entirely. Conflict resolution operates
on version numbers, not cause chains.

*(Source: `packages/memory/v2/consumer.ts`, transact() ~line 115)*

---

## 3. MIME Type Dimension Removed

### v1: `{id, type}` Addresses

v1 facts have both an `of` (entity ID) and a `the` (MIME type, e.g.
`"application/json"`). Every address, key function, and selector includes this
second dimension:

```ts
const toKey = ({ id, type }: BaseMemoryAddress) => `${id}/${type}`;
```

The `the` field appears on facts, in selectors, in the nursery, in the heap,
in the cache, and in the protocol. In practice, it was almost always
`"application/json"`.

### v2: Entity ID Only

v2 entities are addressed by `id` alone. The `EntityId` type is a plain string.

```ts
export type EntityId = string;

export interface FactSet {
  [entityId: EntityId]: FactEntry;
}
```

The v2 runner adapter fixes `the` to `"application/json"` at the boundary for
v1 compatibility:

```ts
const V2_MIME = "application/json" as const;
```

*(Source: `packages/memory/v2/types.ts` ~line 13,
`packages/runner/src/storage/v2/provider.ts` ~line 57)*

---

## 4. Notification Types Simplified

### v1: Five Event Types

The v1 storage subscription system fires five distinct notification types:

| Type        | When                                                      |
|-------------|-----------------------------------------------------------|
| `commit`    | Local optimistic write pushed to nursery                  |
| `revert`    | Server rejected a commit; nursery rolled back             |
| `load`      | Data loaded from local IDB cache into heap                |
| `pull`      | Data pulled from remote server and merged into heap       |
| `integrate` | Server pushed changes (subscription update) into heap     |

Plus `reset` for reconnection scenarios.

### v2: Two Event Types

| Type        | When                                                      |
|-------------|-----------------------------------------------------------|
| `commit`    | Own write applied to local state                          |
| `integrate` | External subscription update received                     |

The other three are unnecessary:

- **`revert`** does not exist because there is no nursery to roll back. A v2
  commit either succeeds synchronously or throws.
- **`load`** does not exist because there is no separate IDB cache phase.
- **`pull`** does not exist because there is no pull-based sync for the local
  provider.

*(Source: `packages/runner/src/storage/interface.ts` ~lines 303-394,
`packages/runner/src/storage/v2/provider.ts` ~lines 224, 387)*

---

## 5. Synchronous vs Async Commits

### v1: Async Commit Pipeline

v1's `Replica.commit()` is async:

1. Build facts with cause chains from current nursery/heap state.
2. Write facts to nursery (optimistic).
3. Fire `commit` notification.
4. `await this.remote.transact(...)` -- send to server over WebSocket.
5. On success: promote nursery to heap, fire no additional notification.
6. On failure: delete from nursery, fire `revert` notification.

Multiple commits can be in-flight simultaneously. If commit B was built on
nursery state from commit A, and A is rejected, B will cascade-fail.

```ts
// v1: commit is async, result comes later
async commit(transaction, source?) {
  this.nursery.merge(changedFacts, Nursery.put);
  this.subscription.next({ type: "commit", ... });
  const result = await this.remote.transact({ changes });
  if (result.error) {
    this.nursery.merge(changedFacts, Nursery.delete);
    this.subscription.next({ type: "revert", ... });
  }
}
```

### v2: Synchronous `transact()`

v2's `ConsumerSession.transact()` is synchronous. The provider validates
and applies the commit immediately:

```ts
// v2: transact is synchronous, result is immediate
transact(userOps, options = {}) {
  const clientCommit = { reads, operations, branch };
  const response = this.invokeProvider(id, {
    cmd: "/memory/transact",
    args: clientCommit,
  });
  // throws on conflict, returns Commit on success
}
```

There is no in-flight queue. The `ReplicaV2.commit()` method calls
`this.consumer.transact(operations)`, updates `localState`, fires a single
`commit` notification, and returns -- all synchronously.

*(Source: `packages/memory/v2/consumer.ts` transact() ~line 115,
`packages/runner/src/storage/v2/provider.ts` ReplicaV2.commit() ~line 144)*

---

## 6. Selector Simplification

### v1: Three-Level Selectors

v1 selectors are three levels deep:

```
entity (of) -> MIME type (the) -> path/schema
```

The `setSelector()` function takes `(selector, entityId, mimeType, cause, pathSelector)`.
Query results (`FactSelection`) are similarly nested:
`{ [entity]: { [mimeType]: { [cause]: { is, since } } } }`.

### v2: Two-Level Selectors

v2 selectors are two levels deep:

```ts
export type Selector = Record<EntityId | "*", EntityMatch>;
```

```
entity (id) -> match specification
```

No MIME type level. The `FactSet` result is flat:

```ts
export interface FactSet {
  [entityId: EntityId]: FactEntry;
}
```

*(Source: `packages/memory/v2/types.ts` ~line 231)*

---

## 7. Conflict Handling

### v1: Implicit Cascade via Cause Chains

In v1, conflict handling is implicit. If the server rejects a fact because its
`cause` doesn't match the current head, all subsequent facts that chained from
it also become invalid. The client discovers this cascade when those subsequent
commits are also rejected.

The `updateLocalFacts` method tracks pending nursery changes via a
`MapSet<string, string>` keyed by entity address and cause hash, so it can
determine which server responses resolve which pending writes.

### v2: Explicit Dependency Declaration

v2's `ClientCommit` has a `reads` field with two sections:

```ts
export interface ClientCommit {
  reads: {
    confirmed: ConfirmedRead[];  // version+hash the client saw
    pending: PendingRead[];      // deps on other in-flight commits
  };
  operations: Operation[];
  branch?: BranchId;
}
```

- `reads.confirmed` lists the versions the client read before writing. The
  server checks these haven't advanced.
- `reads.pending` (for future remote provider) declares explicit dependencies
  on other in-flight commits. If a depended-upon commit is rejected, the
  dependent commit is also rejected -- but this is an explicit declaration,
  not an implicit side-effect of hash chaining.

Each entity's conflict is independent. There is no cascade through unrelated
entities.

*(Source: `packages/memory/v2/types.ts` ~line 192)*

---

## Summary Table

| Aspect                | v1                                    | v2                                    |
|-----------------------|---------------------------------------|---------------------------------------|
| Local cache           | Nursery + Heap (two-tier)             | Single `localState` map               |
| Ordering              | Content-addressed cause chains        | Lamport clock version numbers         |
| Entity address        | `{id, type}` (entity + MIME)          | `id` only                             |
| Notification types    | commit, revert, load, pull, integrate | commit, integrate                     |
| Commit model          | Async (push, await, promote/revert)   | Synchronous (validate + apply)        |
| Selector depth        | 3 levels (MIME/entity/path)           | 2 levels (entity/match)               |
| Conflict detection    | Cause hash mismatch + cascade         | Version comparison, no cascade        |
| Dependency tracking   | Implicit via hash chains              | Explicit `reads.pending` field        |
