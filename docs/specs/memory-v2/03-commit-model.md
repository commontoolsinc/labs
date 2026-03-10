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

An **Operation** describes a single intended mutation within a transaction.
Every operation targets an entity by its `id`.

Operations do **not** include a `parent` field. The server resolves parent
references from its own head state when constructing facts (see §3.7). This
eliminates branded Reference objects from the client-side wire format and
removes a class of bugs (wrong parent hash, stale parent).

```typescript
// Full replacement at the entity root
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

// Tombstone at the entity root
interface DeleteOperation {
  op: "delete";
  id: EntityId;
}

type Operation = SetOperation | PatchWriteOperation | DeleteOperation;
```

**`set`** replaces the entity's entire value. The stored fact records the
complete new state. In path terms, `set` is equivalent to a `replace` at the
entity root (`path: []`).

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
entity can be written to again. In path terms, `delete` is equivalent to a
`remove` at the entity root (`path: []`).

Phase 1 keeps `set` and `delete` as first-class root operations because they map
directly to stored `SetWrite` / `Delete` facts and simplify reconstruction,
point-in-time reads, and merge materialization. Higher-level client APIs MAY
expose only path-based helpers and normalize root `replace` / `remove`
operations into these wire forms before signing the commit.

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
Read(Entity A, path ["profile", "name"]):
  1. Check pending commits (newest first) for writes to A that overlap that path
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
    { id: A, path: [], seq: 5 } — a confirmed read that may conflict with C1
  - By returning "new" (pending), C2's reads contain
    { id: A, path: [], localSeq: 1 } — a pending read that the server
    resolves once C1 is confirmed
```

---

## 3.4 Commit Structure

A **Commit** is the client-submitted record of a transaction. It explicitly
separates its read dependencies into confirmed and pending tiers, enabling the
server to validate freshness and resolve pending references.

```typescript
type SessionId = string;  // Server-issued opaque identifier, resumable across reconnects

interface MergeContext {
  sourceBranch: BranchId;
  sourceSeq: number;
  baseBranch: BranchId;
  baseSeq: number;
}

type ReadPath = readonly string[];  // Relative to EntityDocument.value; [] = root

interface ClientCommit {
  // Client-assigned pending commit index (monotonic per resumable session,
  // starts at 1)
  localSeq: number;

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

  // Optional merge provenance. Merges are still ordinary signed transactions.
  merge?: MergeContext;
}

interface MergeProposal {
  reads: {
    confirmed: ConfirmedRead[];
    pending: [];  // Built against confirmed branch state only
  };
  operations: Operation[];
  branch: BranchId;
  merge: MergeContext;
}

// A read from confirmed (server-acknowledged) state.
// Version-based only — no hash comparison needed.
interface ConfirmedRead {
  id: EntityId;          // Entity that was read
  branch?: BranchId;     // Defaults to commit.branch; set explicitly for merge source/base reads
  path: ReadPath;        // Relative to EntityDocument.value; [] = root
  seq: number;           // Seq number at which that path was observed
}

// A read from another pending (unconfirmed) commit's writes.
// Uses client-local commit indices instead of hashes.
interface PendingRead {
  id: EntityId;          // Entity that was read
  path: ReadPath;        // Relative to EntityDocument.value; [] = root
  localSeq: number;      // Client-local index of the pending commit that
                         // produced this write (monotonically increasing per
                         // client session, starting at 1)
}
```

Read paths are relative to the entity's `value` payload, not the enclosing
`EntityDocument`. A root read is therefore `path: []`, while a read of
`entity.value.profile.name` is recorded as `path: ["profile", "name"]`. The
server re-roots these paths under `"value"` internally when it walks the stored
document.

Confirmed reads are also optionally **branch-scoped**. When `branch` is
omitted, the read is validated against `commit.branch`. Merge proposals use
explicit `branch` values to validate source, target, and merge-base observations
against the correct branch heads.

**Why separate confirmed and pending reads?** The server needs to know which
reads are against confirmed state (so it can validate freshness using seq
comparison) and which are against pending state (so it can resolve them once
the referenced pending commit is confirmed or rejected).

In v1 terminology, these read dependencies are the semantic replacement for
`claims`. v2 does not define a separate claim operation on the wire.

**Why `localSeq` instead of commit hashes?** Pending-read tracking needs a
cheap session-local handle for stacked optimistic writes, so the client assigns
a monotonically increasing local index to each pending commit. The commit hash
still exists as the stable content ID of the canonical `ClientCommit` payload;
the server stores a translation from `localSeq` to the resulting `{ hash, seq }`
once the commit is confirmed. The signed UCAN invocation and authorization that
carried the payload are persisted separately and linked from the resulting
commit record.

---

## 3.5 Stacked Pending Commits

A client can create a commit C2 that reads from the pending writes of a
prior commit C1. This is called **stacking** — C2 is stacked on C1.

```
Timeline:

C1 submitted (pending, localSeq 1):
  - Reads Entity A at path [] from confirmed (seq 5)
  - Writes Entity A = new value

C2 submitted (pending, localSeq 2):
  - Reads Entity A at path [] from C1's pending write (localSeq: 1)
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

This section focuses on the inner `ClientCommit` payload. On the wire, every
`ClientCommit` arrives inside a signed UCAN invocation. The server verifies that
outer invocation/authorization envelope first, then validates and stores the
inner payload described here.

### 3.6.1 Validation Rule

```
For each confirmed read in the commit:
  there MUST NOT exist a later visible fact on
  (read.branch ?? commit.branch)
  whose write footprint overlaps (read.id, read.path)
  and whose seq is > read.seq
```

In prose: the commit's confirmed reads must be **at least as fresh as the latest
overlapping write** on the branch where the read was taken. A later write to
some unrelated path of the same entity does not invalidate the read.

**Why seq-based instead of hash-based?** Strict CAS rejects a commit if
*any* concurrent write touches the same entity, even if the concurrent write
doesn't conflict semantically. Path-aware seq-based validation allows more
concurrency: as long as no newer **overlapping** write exists, your commit is
valid.

### 3.6.1.1 Write-Footprint Overlap

Validation is based on **overlap**, not just entity identity. A later fact
overlaps a read when it could change the value observed at that read path.

Conservative overlap rules:

- A `set` overlaps **every** read path on the same entity.
- A `delete` overlaps **every** read path on the same entity.
- A `patch` overlaps when any contained patch op touches the read path, an
  ancestor of the read path, or a descendant of the read path.
- Structural patch ops (`add`, `remove`, `move`, `splice`) on a collection
  ancestor MAY be treated conservatively as overlapping the entire collection
  subtree for phase 1.

Implementations MAY use more precise overlap analysis, but they MUST NOT miss a
real overlap. False positives are acceptable; false negatives are not.

### 3.6.2 Validation Algorithm

```typescript
function validate(
  commit: ClientCommit,
  serverState: ServerState,
  sessionId: SessionId,
): ValidationResult {
  // 1. Validate confirmed reads
  for (const read of commit.reads.confirmed) {
    const overlappingWrite = serverState.findLatestOverlappingWrite({
      branch: read.branch ?? commit.branch,
      id: read.id,
      path: read.path,
      afterSeq: read.seq,
    });
    if (overlappingWrite !== null) {
      return conflict(read.id, read.path, read, overlappingWrite);
    }
  }

  // 2. Validate pending reads
  for (const read of commit.reads.pending) {
    // Pending resolution is session-scoped FIFO:
    //   read.localSeq refers to an earlier pending commit in THIS session.
    const resolution = serverState.resolveLocalSeq(sessionId, read.localSeq);

    if (resolution === null) {
      // Referenced local commit is not confirmed yet.
      // Hold this commit in the session queue until dependency resolves.
      return pendingDependency(read.localSeq);
    }
    if (resolution.rejected) {
      // Dependency was rejected: cascade rejection through stacked commits.
      return cascadedRejection(read.localSeq);
    }
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

  // Branch on which the conflicting read was validated
  branch: BranchId;

  // Specific value-relative path that conflicted
  path: ReadPath;

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
resolution metadata. The commit log stores successful **write-class** commands:
ordinary `/memory/transact` commits plus branch lifecycle writes
(`/memory/branch/create` and `/memory/branch/delete`).

```typescript
type BranchLifecycleWrite =
  | {
      cmd: "/memory/branch/create";
      args: {
        localSeq: number;
        name: BranchId;
        fromBranch?: BranchId;
        atSeq?: number;
      };
    }
  | {
      cmd: "/memory/branch/delete";
      args: {
        localSeq: number;
        name: BranchId;
      };
    };

type WritePayload = ClientCommit | BranchLifecycleWrite;

interface CommitLogEntry {
  // Content hash of the canonical write payload. For `/memory/transact`, this
  // is the `ClientCommit` hash. For branch lifecycle writes, this is the hash
  // of the normalized `{ cmd, args }` payload. Stable across replay and
  // independent of the outer UCAN wrapper.
  hash: Reference;

  // Raw content-addressed references of the authenticated transport envelope.
  invocationRef: Reference;
  authorizationRef: Reference;

  // Server-issued logical session identifier for the submitting client/space.
  // Pending-read resolution is scoped to this session and survives reconnects.
  sessionId: SessionId;

  // The client-local pending index used on that session.
  localSeq: number;

  // The original semantic write payload extracted from the invocation
  original: WritePayload;

  // Server-assigned resolution metadata
  resolution: {
    // Seq number assigned to this commit
    seq: number;

    // Present for `/memory/transact` rows only. Branch lifecycle writes have no
    // pending-read resolution data.
    resolvedPendingReads?: Array<{
      localSeq: number;
      hash: Reference;
      seq: number;
    }>;
  };
}
```

**Why preserve the original?** The commit log is an audit trail. Preserving the
semantic write payload allows verifiers to replay the relevant logic: for
`/memory/transact`, was the commit valid against the observed reads and writes;
for branch lifecycle writes, was the metadata mutation valid against the branch
state and naming rules? The linked `invocationRef` and `authorizationRef`
preserve who authorized that payload and under which proof. The resolution
metadata records the server's decisions (seq assignment, submitting session,
and, when applicable, pending-read resolution) so the outcome can be
reproduced.

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

### 3.7.4 Commit Hashes, Signing, and Replay

Each committed write-class operation has identifiers with different roles:

- **`hash`** — the content hash of the canonical write payload. For
  `/memory/transact`, this is the `ClientCommit` payload hash. For branch
  lifecycle writes, it is the normalized `{ cmd, args }` payload hash. This is
  stable across retransmission and identifies the semantic write payload.
- **`invocationRef`** — the content hash of the canonical UCAN invocation that
  carried the write over the wire.
- **`authorizationRef`** — the content hash of the verified authorization blob
  whose proof/signature covered `invocationRef`. Batched sibling invocations may
  share this value.
- **`(sessionId, localSeq)`** — the logical idempotence key for replay. For
  `/memory/transact`, it also scopes pending-read resolution.
- **`seq`** — the server-assigned canonical ordering position used by queries,
  subscriptions, and point-in-time reads.

The server verifies the invocation/authorization envelope before accepting a
write-class command, computes the canonical `hash` from the inner semantic
payload (`ClientCommit` for `/memory/transact`, normalized `{ cmd, args }` for
branch lifecycle writes), computes `invocationRef` / `authorizationRef` from
the outer blobs, and stores all three references together with the resolved
metadata. If a client replays the same write after reconnecting, the server
SHOULD deduplicate by `(sessionId, localSeq)` and verify that the replayed
`hash` matches the stored row before returning the existing result. A mismatched
hash for the same `(sessionId, localSeq)` is a protocol error. Replays MAY
arrive inside a fresh invocation or authorization wrapper; that does not change
the identity of the underlying semantic write payload.

### 3.7.5 Session Identity and Reconnect

Pending-read resolution is scoped to a **logical session**, not to a single
TCP/WebSocket connection. The server issues a `SessionId` that is bound to the
authenticated client for a given space and remains valid across reconnects
until the server expires it.

On reconnect:

1. The client resumes the logical session and tells the server the highest
   canonical `seq` it has fully integrated.
2. The client replays any locally retained commits that were not acknowledged,
   plus any retained commits whose assigned `seq` may be newer than the
   server-visible cursor.
3. The server deduplicates replays by `(sessionId, localSeq)` and verifies the
   retained commit `hash`.

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
- "Integrate" notifications for external changes MUST NOT be fired for
  entities/paths whose currently visible state is still shadowed by a more
  advanced local pending state on this client. The provider MAY merge those
  external revisions into a non-current confirmed/heap tier, but it MUST NOT
  notify the scheduler until the pending local state for that entity/path is no
  longer current.
- When a rejected commit rolls back while a later local pending state still
  shadows part of the same entity/path, the resulting "revert" notification is
  based on the **visible** state change only. In practice this can produce a
  partial revert for the subset of entity paths whose visible state actually
  changed after the rejected pending entries were removed.

---

## 3.9 Commit Ordering

Commits are ordered by server-assigned `seq` (space-global Lamport clock):

```
Commit seq=1
Commit seq=2
Commit seq=3
...
```

This ordering provides:

- **Total order** for replay and point-in-time reads
- **Audit trail** — every transaction is recorded with full input and outcome
- **Deterministic validation context** — each commit validates against all prior seqs

Implementations MAY persist an explicit `parent_commit` pointer for convenience,
but protocol/storage semantics are defined by `seq` ordering, not by hash-parent
links between commits.

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
  localSeq: 1,
  reads: { confirmed: [...], pending: [] },
  operations: [{ op: "set", id: "entity:1", value: {...} }],
};

// Commit to a named branch
const commit: ClientCommit = {
  localSeq: 2,
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
| `Assert { is: value }` | `SetOperation` | Same semantics, now explicitly the root write form |
| `Retract { is?: void }` | `DeleteOperation` | Same semantics, now explicitly the root delete form |
| `Claim = true` | `reads.confirmed` / `reads.pending` | Read dependencies moved out of `operations` and now carry paths |
| *(no equivalent)* | `PatchWriteOperation` | New in v2 |
| Heap | Confirmed | Same concept, standard name |
| Nursery | Pending | Same concept, standard name |
| `since` | `seq` | Same concept, renamed for clarity |
| `CommitData.transaction` | `CommitLogEntry.original` | Preserves original submission |
| UCAN transport envelope | `CommitLogEntry.invocationRef` + `CommitLogEntry.authorizationRef` | New: preserves authenticated command wrapper separately from semantic write payload |
| *(implicit)* | `CommitLogEntry.resolution` | New: explicit server-side metadata |

---

Prev: [02-storage.md](./02-storage.md)
Next: [04-protocol.md](./04-protocol.md)
