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
a transaction. Every operation targets an entity by its `id` and declares a
`parent` — the hash of the fact it believes is the current state of that entity.

```typescript
// Full replacement — set the entity to a new value
interface SetOperation {
  op: "set";
  id: EntityId;
  value: JSONValue;
  parent: Reference;   // Hash of the current fact, or Empty reference
}

// Incremental change — apply patch operations to the current value
interface PatchOperation {
  op: "patch";
  id: EntityId;
  patches: PatchOp[];  // Ordered list of JSON Patch operations
  parent: Reference;   // Hash of the current fact
}

// Tombstone — mark the entity as deleted
interface DeleteOperation {
  op: "delete";
  id: EntityId;
  parent: Reference;   // Hash of the current fact
}

// Read assertion — declare a read dependency without mutating
interface ClaimOperation {
  op: "claim";
  id: EntityId;
  parent: Reference;   // Hash of the fact that was read
}

type Operation = SetOperation | PatchOperation | DeleteOperation | ClaimOperation;
```

**`set`** replaces the entity's entire value. The stored fact records the
complete new state. This is the simplest mutation and the only one required for
a minimal implementation.

**`patch`** applies an ordered list of incremental operations to the entity's
current state. The stored fact records the patch ops themselves (not the
resulting value). See section 2 (Storage) for how patches are stored and
replayed. Patch operations follow JSON Patch (RFC 6902) with extensions:

```typescript
type PatchOp =
  | { op: "replace"; path: string; value: JSONValue }
  | { op: "add"; path: string; value: JSONValue }
  | { op: "remove"; path: string }
  | { op: "move"; from: string; path: string }
  | { op: "splice"; path: string; index: number; remove: number; add: JSONValue[] };
```

**`delete`** tombstones the entity. The resulting fact has no `value` — it
records only the `parent` reference to the fact being deleted. A deleted entity
can be written to again (the new write's `parent` will be the delete fact's
hash).

**`claim`** does not mutate state. It declares that the transaction read the
entity and depends on it being in the stated version. If the entity has changed
since the claimed `parent`, the transaction is rejected. This enables
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
|  |  version numbers and hashes.          |  |
|  |                                       |  |
|  |  Entity A: { version: 5, hash: H5 }  |  |
|  |  Entity B: { version: 3, hash: H3 }  |  |
|  +---------------------------------------+  |
|                                             |
|  +---------------------------------------+  |
|  |           Pending                     |  |
|  |                                       |  |
|  |  Optimistic local writes. May be      |  |
|  |  rejected by server. Provisional      |  |
|  |  hashes (computed locally but not      |  |
|  |  finalized until confirmed).          |  |
|  |                                       |  |
|  |  C1: { Entity A: set(...) }  [sent]   |  |
|  |  C2: { Entity B: set(...) }  [sent]   |  |
|  |  C3: { Entity A: patch(...)} [local]  |  |
|  +---------------------------------------+  |
+---------------------------------------------+
```

### 3.3.1 Confirmed State

The **confirmed** tier contains facts that the server has acknowledged. Each
confirmed fact has:

- A **version** number assigned by the server (monotonically increasing per
  space)
- A **hash** — the content hash of the stored fact
- The fact's **value** (for reads and local computation)

Confirmed state is authoritative. It represents the client's last known
consistent view of server state. When the server confirms a pending commit,
the affected entities move from pending to confirmed.

### 3.3.2 Pending State

The **pending** tier contains commits that the client has submitted (or is
about to submit) but that the server has not yet confirmed. Pending commits
are ordered — they form a queue of outstanding writes.

Each pending commit has:

- A **provisional hash** — computed locally from the commit contents. This hash
  may differ from the server-assigned hash because hashes depend on `parent`
  references, which may be provisional.
- The **operations** included in the commit
- References to **reads**: which confirmed or pending facts this commit
  depended on

Pending state is optimistic. The client applies pending writes locally so the
UI reflects intended changes immediately. But pending writes may be rejected
by the server (due to conflicts), in which case they are discarded.

### 3.3.3 Reading Across Tiers

When a client reads an entity, it checks pending state first (most recent
pending commit wins), then falls back to confirmed state. This means local
writes are immediately visible to subsequent local reads.

```
Read(Entity A):
  1. Check pending commits (newest first) for writes to A
  2. If found → return pending value (provisional)
  3. If not found → return confirmed value (authoritative)
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

// A read from confirmed (server-acknowledged) state
interface ConfirmedRead {
  id: EntityId;          // Entity that was read
  hash: Reference;       // Hash of the fact that was read
  version: number;       // Version number of that fact
}

// A read from another pending (unconfirmed) commit's writes
interface PendingRead {
  id: EntityId;          // Entity that was read
  hash: Reference;       // Provisional hash from the pending commit
  fromCommit: Reference; // Hash of the pending commit that produced this write
}
```

**Why separate confirmed and pending reads?** The server needs to know which
reads are against confirmed state (so it can validate freshness using version
comparison) and which are against pending state (so it can resolve them once
the referenced pending commit is confirmed or rejected).

---

## 3.5 Stacked Pending Commits

A client can create a commit C2 that reads from the pending writes of a
prior commit C1. This is called **stacking** — C2 is stacked on C1.

```
Timeline:

C1 submitted (pending):
  - Reads Entity A from confirmed (version 5)
  - Writes Entity A = new value

C2 submitted (pending):
  - Reads Entity A from C1's pending write (fromCommit: hash(C1))
  - Writes Entity B based on A's new value

Server confirms C1 → C1 moves to confirmed
Server validates C2 → C2's pending read resolves to C1's confirmed write → OK
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
applying any writes. The validation uses **version-based comparison** rather
than strict hash comparison (CAS).

### 3.6.1 Validation Rule

```
For each confirmed read in the commit:
  commit.reads.confirmed[i].version >= server.head[entity].version
```

In prose: the commit's confirmed reads must be **at least as fresh** as the
server's current head for each entity. This is strictly weaker than CAS (which
requires exact hash match) — it allows concurrent non-conflicting writes to
proceed.

**Why version-based instead of hash-based?** Strict CAS rejects a commit if
*any* concurrent write touches the same entity, even if the concurrent write
doesn't conflict semantically. Version-based validation allows more
concurrency: as long as your read is not stale (no newer version exists), your
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
      if (read.version !== 0) {
        return conflict(read.id, read, head);
      }
    } else if (read.version < head.version) {
      // Client's read is stale — a newer version exists
      return conflict(read.id, read, head);
    }
  }

  // 2. Validate pending reads
  for (const read of commit.reads.pending) {
    const resolution = serverState.resolvedCommit(read.fromCommit);
    if (resolution === null) {
      // Referenced pending commit hasn't been confirmed yet.
      // Server should hold this commit until the dependency resolves,
      // or reject if the dependency was already rejected.
      return pendingDependency(read.fromCommit);
    }
    if (resolution.rejected) {
      return cascadedRejection(read.fromCommit);
    }
    // Pending read is resolved — the entity now has a confirmed version
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

  // What the client thought the current version was
  expected: {
    version: number;
    hash: Reference;
  };

  // What the server's actual current version is
  actual: {
    version: number;
    hash: Reference;
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
2. **Assign version**: The commit receives the next version number for the space
   (on the target branch). Version numbers are monotonically increasing — a
   Lamport clock scoped to the space.
3. **Apply operations**: For each write/patch/delete operation:
   - Compute the fact hash (includes the `parent` reference)
   - Store the fact in the fact table
   - Update the head pointer for the entity
4. **Record the commit**: Write a `CommitLogEntry` to the commit log
5. **Notify subscribers**: Push the commit to all active subscriptions that
   match the changed entities

All of steps 2-4 happen within a single database transaction to ensure
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
    // Version number assigned to this commit
    version: number;

    // Mapping from provisional commit hashes to their resolved versions.
    // When a pending commit is confirmed, its provisional hash maps to
    // the assigned version number.
    commitResolutions: Map<Reference, number>;

    // Mapping from provisional fact hashes to final fact hashes.
    // Provisional hashes can differ from final hashes because the hash
    // of a fact includes its `parent`. If the parent was provisional
    // (from a pending commit), the final hash changes once the parent
    // is resolved.
    hashMappings?: Map<Reference, Reference>;
  };
}
```

**Why preserve the original?** The commit log is an audit trail. Preserving the
original submission allows verifiers to replay the validation logic: given the
server state at the time, was this commit valid? The resolution metadata records
the server's decisions (version assignment, hash resolution) so the outcome can
be reproduced.

### 3.7.3 Version Assignment

Versions are assigned per space, per branch. The version is a monotonically
increasing integer (Lamport clock):

```
Branch "main": version 1, 2, 3, 4, ...
Branch "draft": version 1, 2, 3, ...
```

All facts produced by a single commit share the same version number. This
creates a direct relationship between facts and their producing commit:

```
Fact → version=N → CommitLogEntry with version=N
```

Given any fact, the client can find the producing commit by querying for the
commit log entry with the matching version.

---

## 3.8 Commit Chain

Commits on a branch form a chain, where each commit references the previous
one:

```
Genesis Commit (parent: empty)
    |
    v
Commit v=1 (parent: genesis hash)
    |
    v
Commit v=2 (parent: commit v=1 hash)
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

## 3.9 Atomicity Guarantees

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

## 3.10 Branch-Aware Commits

Every commit targets a specific branch. If no branch is specified, the commit
targets the default branch.

```typescript
// Commit to the default branch
const commit: ClientCommit = {
  reads: { confirmed: [...], pending: [] },
  operations: [{ op: "set", id: "entity:1", value: {...}, parent: H1 }],
};

// Commit to a named branch
const commit: ClientCommit = {
  reads: { confirmed: [...], pending: [] },
  operations: [{ op: "set", id: "entity:1", value: {...}, parent: H1 }],
  branch: "draft",
};
```

Branch-level details (creation, merging, isolation) are covered in section 6
(Branching).

---

## 3.11 Client Retry Strategy

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
  |  Commit C1 (reads A@v5)       |
  |  ----------------------------→|
  |                                |  A is now at v6 (another client wrote)
  |  ConflictError                 |
  |  { actual: A@v6 }             |
  |  ←----------------------------|
  |                                |
  |  Update confirmed: A@v6       |
  |  Rebuild C1' (reads A@v6)     |
  |                                |
  |  Commit C1' (reads A@v6)      |
  |  ----------------------------→|
  |  OK (v=7)                      |
  |  ←----------------------------|
```

The client library SHOULD implement automatic retry with a configurable retry
limit. The default retry strategy is:

1. Retry immediately (the conflict response includes the current values).
2. If the retry also conflicts, back off exponentially.
3. After N retries (default: 3), surface the conflict to the application layer.

---

## 3.12 Mapping from Current Implementation

The following table maps concepts from the current (v1) commit model to the
v2 model described in this section.

| v1 Concept | v2 Concept | Notes |
|------------|------------|-------|
| `cause` (hash-based CAS) | `parent` + version-based validation | Relaxed from strict CAS to version comparison |
| `Changes` (nested `of/the/cause` map) | `Operation[]` (flat list) | Simpler, typed, extensible |
| `Assert { is: value }` | `SetOperation` | Same semantics, cleaner type |
| `Retract { is?: void }` | `DeleteOperation` | Same semantics |
| `Claim = true` | `ClaimOperation` | Same semantics, explicit type |
| *(no equivalent)* | `PatchOperation` | New in v2 |
| Heap | Confirmed | Same concept, standard name |
| Nursery | Pending | Same concept, standard name |
| `since` | `version` | Same concept, standard name |
| `CommitData.transaction` | `CommitLogEntry.original` | Preserves original submission |
| *(implicit)* | `CommitLogEntry.resolution` | New: explicit server-side metadata |

---

Prev: [02-storage.md](./02-storage.md)
Next: [04-protocol.md](./04-protocol.md)
