# 3. Commit Model

The commit model defines how state changes are proposed, validated, and
recorded. It provides **atomicity** (all operations in a transaction succeed or
all fail), **serializability** (transactions appear to execute one at a time),
and **auditability** (every mutation is recorded in an append-only log).

This section describes the full commit pipeline: client transaction construction,
server-side validation, conflict handling, and the two-tier client state model
(confirmed/pending) that enables optimistic local writes.

---

## 3.1 Operations

An **Operation** describes a single intended mutation (or read assertion) within
a transaction. Every operation targets an entity by its `id`.

Operations do **not** include a `parent` field. The server resolves parent
references from its own head state when constructing facts (see §3.7). This
eliminates branded Reference objects from the client-side wire format and
removes a class of bugs (wrong parent hash, stale parent).

```typescript
// Full replacement — set the entity to a new value
interface SetOperation {
  op: "set";
  id: EntityId;
  value: JSONValue;
}

// Incremental change — apply patch operations to the current value
interface PatchWriteOperation {
  op: "patch";
  id: EntityId;
  patches: PatchOp[];  // Ordered list of patch operations
}

// Tombstone — mark the entity as deleted
interface DeleteOperation {
  op: "delete";
  id: EntityId;
}

// Read assertion — declare a read dependency without mutating
interface ClaimOperation {
  op: "claim";
  id: EntityId;
}

type Operation = SetOperation | PatchWriteOperation | DeleteOperation | ClaimOperation;
```

**`set`** replaces the entity's entire value. The stored fact records the
complete new state. This is the simplest mutation and the only one required for
a minimal implementation.

**`patch`** applies an ordered list of incremental operations to the entity's
current state (`PatchWriteOperation`). The stored fact records the patch ops
themselves (not the resulting value). See section 2 (Storage) for how patches
are stored and replayed. Patch operations are inspired by JSON Patch (RFC 6902)
but are not bound by it — see §01 Data Model section 6 for details:

```typescript
type PatchOp =
  | { op: "replace"; path: string; value: JSONValue }
  | { op: "add"; path: string; value: JSONValue }
  | { op: "remove"; path: string }
  | { op: "move"; from: string; path: string }
  | { op: "splice"; path: string; index: number; remove: number; add: JSONValue[] };
```

**`delete`** tombstones the entity. The resulting fact has no `value`. A deleted
entity can be written to again.

**`claim`** does not mutate state. It declares that the transaction read the
entity and depends on it being at the stated seq. If the entity has changed
since the claimed seq, the transaction is rejected. This enables
STM-style (Software Transactional Memory) read validation: list every entity
you read to ensure none have changed.

---

## 3.2 Transaction Structure

A **Transaction** groups one or more operations into an atomic unit. All
operations succeed or all fail — there is no partial application.

```typescript
interface Transaction {
  // The operations to apply, in order
  operations: Operation[];

  // Optional: content-addressed code bundle that produced this transaction.
  // Enables provenance tracking and verification.
  codeCID?: Reference;

  // Optional: branch to target. Defaults to the default branch if omitted.
  branch?: BranchId;
}
```

A transaction MUST contain at least one operation. The server processes
operations in the order they appear, but validation of all reads happens
before any writes are applied (see 3.6).

---

## 3.3 Client State: Confirmed and Pending

Clients maintain two tiers of state to support optimistic local writes while
waiting for server confirmation.

```
+---------------------------------------------+
|               Client State                  |
|                                             |
|  +---------------------------------------+  |
|  |           Confirmed                   |  |
|  |                                       |  |
|  |  Server-acknowledged facts with real  |  |
|  |  seq numbers.                         |  |
|  |                                       |  |
|  |  Entity A: { seq: 5 }                |  |
|  |  Entity B: { seq: 3 }                |  |
|  +---------------------------------------+  |
|                                             |
|  +---------------------------------------+  |
|  |           Pending                     |  |
|  |                                       |  |
|  |  Optimistic local writes. May be      |  |
|  |  rejected by server. Tracked by       |  |
|  |  client-local commit index (localSeq).|  |
|  |                                       |  |
|  |  localSeq 1: { Entity A: set(...) }   |  |
|  |  localSeq 2: { Entity B: set(...) }   |  |
|  |  localSeq 3: { Entity A: patch(...)}  |  |
|  +---------------------------------------+  |
+---------------------------------------------+
```

### 3.3.1 Confirmed State

The **confirmed** tier contains facts that the server has acknowledged. Each
confirmed fact has:

- A **seq** number assigned by the server (monotonically increasing per space)
- The fact's **value** (for reads and local computation)

Confirmed state is authoritative. It represents the client's last known
consistent view of server state. When the server confirms a pending commit,
the affected entities move from pending to confirmed.

### 3.3.2 Pending State

The **pending** tier contains commits that the client has submitted (or is
about to submit) but that the server has not yet confirmed. Pending commits
are ordered — they form a queue of outstanding writes.

Each pending commit has:

- A **localSeq** — a client-assigned index (monotonically increasing per
  session, starting at 1). Used to track pending reads across stacked commits.
- The **operations** included in the commit
- References to **reads**: which confirmed or pending facts this commit
  depended on

Pending state is optimistic. The client applies pending writes locally so the
UI reflects intended changes immediately. But pending writes may be rejected
by the server (due to conflicts), in which case they are discarded.

### 3.3.3 Reading Across Tiers

When a client reads an entity, it **MUST check pending state first** (most
recent pending commit wins), then fall back to confirmed state. This means
local writes are immediately visible to subsequent local reads.

**This read precedence is critical for pipelining correctness.** If `.get()`
returns confirmed state when a pending write exists, pipelined transactions
will read stale data and produce false conflicts when the server validates them.

```
Read(Entity A):
  1. Check pending commits (newest first) for writes to A
  2. If found → return pending value (provisional)
  3. If not found → return confirmed value (authoritative)
```

**Worked example — why pending-first matters for pipelining:**

```
Confirmed: Entity A = "old" (seq 5)

Transaction C1 (pending, localSeq 1):
  - Writes Entity A = "new"
  → C1 is submitted to server, awaiting confirmation

Transaction C2 (built while C1 is pending):
  - Reads Entity A → MUST return "new" (from C1's pending write)
  - If it returned "old" (confirmed), C2's reads would contain
    { id: A, seq: 5 } — a confirmed read that may conflict with C1
  - By returning "new" (pending), C2's reads contain
    { id: A, localSeq: 1 } — a pending read that the server
    resolves once C1 is confirmed
```

---

## 3.4 Commit Structure

A **Commit** is the client-submitted record of a transaction. It explicitly
separates its read dependencies into confirmed and pending tiers, enabling the
server to validate freshness and resolve pending references.

```typescript
interface ClientCommit {
  // Read dependencies from confirmed state
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };

  // The operations to apply
  operations: Operation[];

  // Optional provenance
  codeCID?: Reference;

  // Target branch (defaults to default branch)
  branch?: BranchId;
}

// A read from confirmed (server-acknowledged) state.
// Version-based only — no hash comparison needed.
interface ConfirmedRead {
  id: EntityId;          // Entity that was read
  seq: number;           // Seq number of the confirmed fact that was read
}

// A read from another pending (unconfirmed) commit's writes.
// Uses client-local commit indices instead of hashes.
interface PendingRead {
  id: EntityId;          // Entity that was read
  localSeq: number;      // Client-local index of the pending commit that
                         // produced this write (monotonically increasing per
                         // client session, starting at 1)
}
```

**Why separate confirmed and pending reads?** The server needs to know which
reads are against confirmed state (so it can validate freshness using seq
comparison) and which are against pending state (so it can resolve them once
the referenced pending commit is confirmed or rejected).

**Why `localSeq` instead of commit hashes?** The client assigns a
monotonically increasing local index to each pending commit. This is simpler
than computing and tracking provisional hashes. The server annotates stored
commits with a mapping from `localSeq` to server-side commit identifiers; this
annotation is separate from the signed payload.

---

## 3.5 Stacked Pending Commits

A client can create a commit C2 that reads from the pending writes of a
prior commit C1. This is called **stacking** — C2 is stacked on C1.

```
Timeline:

C1 submitted (pending, localSeq 1):
  - Reads Entity A from confirmed (seq 5)
  - Writes Entity A = new value

C2 submitted (pending, localSeq 2):
  - Reads Entity A from C1's pending write (localSeq: 1)
  - Writes Entity B based on A's new value

Server confirms C1 → C1 moves to confirmed
Server validates C2 → C2's pending read (localSeq: 1) resolves to C1's
  confirmed write → OK
```

**Cascading rejection**: If C1 is rejected (conflict), then C2 MUST also be
rejected, because C2's inputs are invalid. The client must discard both,
re-read the conflicting entities from confirmed state, and rebuild both
transactions.

```
C1 rejected (conflict on Entity A):
  → C2 also rejected (read from C1's now-invalid write)
  → Client discards C1 and C2 from pending
  → Client re-reads Entity A from confirmed
  → Client rebuilds C1' and C2' with fresh reads
  → Client submits C1', then C2'
```

More generally, rejection cascades through the entire chain: if C1 fails, then
C2 (which depends on C1), C3 (which depends on C2), etc., all fail.

---

## 3.6 Server Validation

When the server receives a commit, it validates all read dependencies before
applying any writes. The validation uses **seq-based comparison** rather
than strict hash comparison (CAS).

### 3.6.1 Validation Rule

```
For each confirmed read in the commit:
  commit.reads.confirmed[i].seq >= server.head[entity].seq
```

In prose: the commit's confirmed reads must be **at least as fresh** as the
server's current head for each entity. This is strictly weaker than CAS (which
requires exact hash match) — it allows concurrent non-conflicting writes to
proceed.

**Why seq-based instead of hash-based?** Strict CAS rejects a commit if
*any* concurrent write touches the same entity, even if the concurrent write
doesn't conflict semantically. Seq-based validation allows more
concurrency: as long as your read is not stale (no newer seq exists), your
commit is valid.

### 3.6.2 Validation Algorithm

```typescript
function validate(
  commit: ClientCommit,
  serverState: ServerState,
): ValidationResult {
  // 1. Validate confirmed reads
  for (const read of commit.reads.confirmed) {
    const head = serverState.head(read.id, commit.branch);
    if (head === null) {
      // Entity doesn't exist on server — valid only if read was Empty
      if (read.seq !== 0) {
        return conflict(read.id, read, head);
      }
    } else if (read.seq < head.seq) {
      // Client's read is stale — a newer seq exists
      return conflict(read.id, read, head);
    }
  }

  // 2. Validate pending reads
  for (const read of commit.reads.pending) {
    // The server maps localSeq to a server-side commit using the
    // per-session localSeq→commit mapping (see §3.7.2).
    const resolution = serverState.resolveLocalSeq(
      commit.session, read.localSeq
    );
    if (resolution === null) {
      // Referenced pending commit hasn't been confirmed yet.
      // Server should hold this commit until the dependency resolves,
      // or reject if the dependency was already rejected.
      return pendingDependency(read.localSeq);
    }
    if (resolution.rejected) {
      return cascadedRejection(read.localSeq);
    }
    // Pending read is resolved — the entity now has a confirmed seq
  }

  // 3. All reads valid — apply writes atomically
  return valid();
}
```

### 3.6.3 Conflict Response

When validation fails, the server returns a `ConflictError` with enough detail
for the client to understand what went wrong and retry.

```typescript
interface ConflictError extends Error {
  name: "ConflictError";

  // The commit that was rejected
  commit: ClientCommit;

  // Details about each conflicting entity
  conflicts: ConflictDetail[];
}

interface ConflictDetail {
  // Entity where the conflict occurred
  id: EntityId;

  // What the client thought the current seq was
  expected: {
    seq: number;
  };

  // What the server's actual current state is
  actual: {
    seq: number;
    value?: JSONValue;  // Optionally included to save a round-trip
  };
}
```

---

## 3.7 Server-Side Commit Processing

When a commit passes validation, the server applies it atomically and records
it in the commit log.

### 3.7.1 Processing Steps

1. **Validate** all read dependencies (section 3.6)
2. **Assign seq**: The commit receives the next seq number from the
   space-global Lamport clock. Seq numbers are monotonically increasing
   and shared across all branches (see §3.7.3).
3. **Resolve parents**: For each operation, look up the entity's current head
   to determine the `parent` reference for the resulting fact. If the entity
   has no head, the parent is the Empty reference.
4. **Apply operations**: For each write/patch/delete operation:
   - Compute the fact hash (includes the resolved `parent` reference)
   - Store the fact in the fact table
   - Update the head pointer for the entity
5. **Record the commit**: Write a `CommitLogEntry` to the commit log
6. **Notify subscribers**: Push the commit to all active subscriptions that
   match the changed entities

All of steps 2-5 happen within a single database transaction to ensure
atomicity.

### 3.7.2 CommitLogEntry

The commit log preserves both the original client submission and the server's
resolution metadata.

```typescript
interface CommitLogEntry {
  // The original commit as submitted by the client
  original: ClientCommit;

  // Server-assigned resolution metadata
  resolution: {
    // Seq number assigned to this commit
    seq: number;

    // Mapping from client-local commit indices (localSeq) to server-side
    // seq numbers. When a pending commit is confirmed, the server records
    // which localSeq value maps to which server seq. This allows
    // subsequent pending reads (which reference localSeq) to be resolved.
    localSeqMappings: Map<number, number>;
  };
}
```

**Why preserve the original?** The commit log is an audit trail. Preserving the
original submission allows verifiers to replay the validation logic: given the
server state at the time, was this commit valid? The resolution metadata records
the server's decisions (seq assignment, localSeq resolution) so the outcome can
be reproduced.

### 3.7.3 Seq Assignment

Seq numbers are assigned from a single space-global Lamport clock. All branches
share the same seq sequence. This ensures cross-branch ordering for
point-in-time queries.

```
Commit on "main":  seq 1
Commit on "main":  seq 2
Commit on "draft": seq 3   ← global, not per-branch
Commit on "main":  seq 4
```

All facts produced by a single commit share the same seq number. This
creates a direct relationship between facts and their producing commit:

```
Fact → seq=N → CommitLogEntry with seq=N
```

Given any fact, the client can find the producing commit by querying for the
commit log entry with the matching seq.

---

## 3.8 Notification Ordering Guarantee

When multiple pending commits are in-flight, notifications for a given entity
must reflect **causal order**. The client MUST NOT notify about a later
commit's confirmation until all earlier commits for overlapping entities are
resolved.

### 3.8.1 Notification Types

The client provider fires three types of notifications to the scheduler:

1. **"commit"** — Fired **synchronously** within the `.commit()` call, before
   the returned promise settles. Contains the entity-level before/after diffs
   from the optimistic local apply. This is the primary mechanism for reactivity.

2. **"revert"** — Fired when the server rejects a commit. Contains the diffs
   from rolling back the optimistic state to the correct confirmed state (or
   to whatever the server says is current). Must fire **before** the commit
   promise resolves with the error.

3. **"integrate"** — Fired when subscription updates arrive from other clients.
   Contains the diffs from incorporating external changes into confirmed state.
   May fire via microtask.

### 3.8.2 Ordering Rules

- For a **successful** local commit, there is exactly **one** synchronous
  "commit" notification. No additional notifications are fired for that
  commit when the server confirms it (the optimistic state was already correct).
- For a **rejected** commit, the "commit" notification was already fired
  (synchronously). A "revert" notification fires when the rejection arrives,
  **before** the commit promise resolves with the error.
- When a "revert" and an "integrate" overlap (the server rejects our commit
  but also delivers an external update for the same entity), the provider
  performs a **partial revert**: it skips entities that were already superseded
  by the integrate, reverting only the remaining entities.
- "Integrate" notifications for external changes MUST NOT be fired for
  entities that are in pending state on this client. Wait until the pending
  commit for that entity is resolved (confirmed or rejected) first.

---

## 3.9 Commit Chain

Commits on a branch form a chain, where each commit references the previous
one:

```
Genesis Commit (parent: empty)
    |
    v
Commit seq=1 (parent: genesis hash)
    |
    v
Commit seq=2 (parent: commit seq=1 hash)
    |
    v
   ...
```

This chain provides:

- **Total ordering** of all transactions on a branch
- **Audit trail** — every transaction is recorded with its full content
- **Consistency anchor** — verifiers can trace the complete history from any
  point back to genesis

The genesis commit is the first commit on a branch. Its parent is the empty
reference for the space. For the default branch, the genesis commit establishes
the root of trust for the space.

---

## 3.10 Atomicity Guarantees

A transaction is atomic: all operations succeed or all fail. The server MUST
NOT apply a partial transaction.

**Within a transaction:**
- If operation 3 of 5 fails validation, none of the 5 operations are applied.
- If the database write for operation 3 fails, the entire database transaction
  is rolled back.

**Across transactions:**
- Transactions are serialized within a branch. The server processes one
  transaction at a time per branch (or uses optimistic concurrency control
  that is equivalent to serial execution).
- Transactions on different branches are independent and can proceed in
  parallel.

---

## 3.11 Branch-Aware Commits

Every commit targets a specific branch. If no branch is specified, the commit
targets the default branch.

```typescript
// Commit to the default branch
const commit: ClientCommit = {
  reads: { confirmed: [...], pending: [] },
  operations: [{ op: "set", id: "entity:1", value: {...} }],
};

// Commit to a named branch
const commit: ClientCommit = {
  reads: { confirmed: [...], pending: [] },
  operations: [{ op: "set", id: "entity:1", value: {...} }],
  branch: "draft",
};
```

Branch-level details (creation, merging, isolation) are covered in section 6
(Branching).

---

## 3.12 Client Retry Strategy

When a commit is rejected due to a conflict, the client should:

1. **Read the conflict details** from the `ConflictError` response.
2. **Update confirmed state** with the server's actual values (provided in the
   conflict response or fetched separately).
3. **Discard the rejected commit** and any stacked commits that depended on it
   from the pending queue.
4. **Rebuild the transaction** using the updated confirmed state. This may
   involve re-running the application logic that produced the original
   transaction, since the inputs have changed.
5. **Resubmit** the rebuilt transaction.

```
Client                          Server
  |                                |
  |  Commit C1 (reads A@seq5)     |
  |  ----------------------------→|
  |                                |  A is now at seq6 (another client wrote)
  |  ConflictError                 |
  |  { actual: A@seq6 }           |
  |  ←----------------------------|
  |                                |
  |  Update confirmed: A@seq6     |
  |  Rebuild C1' (reads A@seq6)   |
  |                                |
  |  Commit C1' (reads A@seq6)    |
  |  ----------------------------→|
  |  OK (seq=7)                    |
  |  ←----------------------------|
```

The client library SHOULD implement automatic retry with a configurable retry
limit. The default retry strategy is:

1. Retry immediately (the conflict response includes the current values).
2. If the retry also conflicts, back off exponentially.
3. After N retries (default: 3), surface the conflict to the application layer.

---

## 3.13 Mapping from Current Implementation

The following table maps concepts from the current (v1) commit model to the
v2 model described in this section.

| v1 Concept | v2 Concept | Notes |
|------------|------------|-------|
| `cause` (hash-based CAS) | Server-side `parent` + seq-based validation | Relaxed from strict CAS to seq comparison; client doesn't send parent |
| `Changes` (nested `of/the/cause` map) | `Operation[]` (flat list) | Simpler, typed, extensible |
| `Assert { is: value }` | `SetOperation` | Same semantics, cleaner type |
| `Retract { is?: void }` | `DeleteOperation` | Same semantics |
| `Claim = true` | `ClaimOperation` | Same semantics, explicit type |
| *(no equivalent)* | `PatchWriteOperation` | New in v2 |
| Heap | Confirmed | Same concept, standard name |
| Nursery | Pending | Same concept, standard name |
| `since` | `seq` | Same concept, renamed for clarity |
| `CommitData.transaction` | `CommitLogEntry.original` | Preserves original submission |
| *(implicit)* | `CommitLogEntry.resolution` | New: explicit server-side metadata |

---

Prev: [02-storage.md](./02-storage.md)
Next: [04-protocol.md](./04-protocol.md)
