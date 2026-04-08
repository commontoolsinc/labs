# 3. Commit Model

The commit model defines how state changes are proposed, validated, and
recorded. It provides atomicity (all operations in a transaction succeed or all
fail), serializability (transactions appear to execute one at a time), and
auditability (every mutation is recorded in an append-only commit log linked to
its UCAN envelope).

This revision removes semantic hashes from the JSON write path. A pending write
is identified by `(sessionId, localSeq)` and a confirmed write is identified by
its canonical `seq`.

## 3.1 Operations

An operation describes a single intended mutation within a transaction. Every
operation targets an entity by `id`.

```typescript
interface SetOperation {
  op: "set";
  id: EntityId;
  value: EntityDocument;
}

interface PatchWriteOperation {
  op: "patch";
  id: EntityId;
  patches: PatchOp[];
}

interface DeleteOperation {
  op: "delete";
  id: EntityId;
}

type Operation = SetOperation | PatchWriteOperation | DeleteOperation;
```

Operations do not include parent hashes or other version identifiers. The server
validates the read set, assigns a canonical `seq`, and records one or more
sequenced revisions. `set` carries a logical `EntityDocument`; `patch` carries
path-targeted edits whose leaf values use the shared rich-value surface rather
than a JSON-only subset.

## 3.2 Transaction Structure

A transaction groups one or more operations into an atomic unit. All operations
succeed or all fail.

```typescript
interface Transaction {
  operations: Operation[];
  codeCID?: Reference;
  branch?: BranchId;
}
```

A transaction MUST contain at least one operation. Validation of all reads
happens before any writes are applied.

## 3.3 Client State: Confirmed and Pending

Clients maintain two tiers of state to support optimistic local writes while
waiting for server confirmation.

### 3.3.1 Confirmed State

The confirmed tier contains server-acknowledged state:

- the latest integrated entity values
- the canonical `seq` for those visible values
- any external changes incorporated from session sync frames

Confirmed state is authoritative. It represents the client's last known
consistent server view.

### 3.3.2 Pending State

The pending tier contains optimistic local commits that have not yet been
confirmed. Pending commits are ordered by `localSeq`, which is monotonic within
the logical session.

Each pending commit has:

- a `localSeq`
- the operations included in the commit
- `reads.confirmed` dependencies on confirmed state
- `reads.pending` dependencies on earlier optimistic commits

### 3.3.3 Reading Across Tiers

When a client reads an entity, it MUST check pending state first, newest to
oldest, then fall back to confirmed state. This ensures pipelined transactions
see their own optimistic writes.

```text
Read(entity, path):
  1. Check pending commits for overlapping writes at that path
  2. If found, read from the newest matching pending write
  3. Otherwise read from confirmed state
```

### 3.3.4 Single-Snapshot Rule

A transaction's reads and writes MUST be computed against a single stable local
snapshot. While application code is building a transaction, incoming server sync
frames are buffered rather than applied immediately. The client applies those
buffered frames only after the transaction has been submitted or abandoned.

This rule makes the submitted `reads.confirmed[].seq` values meaningful: they
describe one coherent client view, not a mixture of states observed before and
after unrelated incoming changes.

## 3.4 Commit Structure

A client commit explicitly separates dependencies on confirmed state from
dependencies on earlier pending commits.

```typescript
type ReadPath = readonly string[];
type SessionId = string;

interface MergeContext {
  sourceBranch: BranchId;
  sourceSeq: number;
  baseBranch: BranchId;
  baseSeq: number;
}

interface ClientCommit {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
  codeCID?: Reference;
  branch?: BranchId;
  merge?: MergeContext;
}

interface ConfirmedRead {
  id: EntityId;
  branch?: BranchId;
  path: ReadPath;
  seq: number;
}

interface PendingRead {
  id: EntityId;
  path: ReadPath;
  localSeq: number;
}
```

Confirmed reads are validated against canonical history. Pending reads are
resolved within the submitting logical session.

## 3.5 Stacked Pending Commits

A client can create commit `C2` that reads from the optimistic writes of earlier
commit `C1`.

```text
C1 submitted (pending, localSeq 1):
  - reads Entity A from confirmed seq 5
  - writes Entity A

C2 submitted (pending, localSeq 2):
  - reads Entity A from localSeq 1
  - writes Entity B derived from A
```

If `C1` is later confirmed, the server resolves `C2`'s pending read to that
confirmed commit. If `C1` is rejected, `C2` is invalid and must be rejected as
well. Rejection therefore cascades through the stack of dependent pending
commits.

## 3.6 Server Validation

When the server receives a commit, it validates all read dependencies before
applying any writes.

### 3.6.1 Validation Rule

For each confirmed read in the commit:

```text
there MUST NOT exist a later visible overlapping write on
(read.branch ?? commit.branch)
with seq > read.seq
```

The validation model is path-aware and seq-based. A later write to an unrelated
path on the same entity does not invalidate the read.

### 3.6.2 Write-Footprint Overlap

Validation is based on overlap, not just entity identity.

- `set` overlaps every read path on the same entity
- `delete` overlaps every read path on the same entity
- `patch` overlaps when any patch op touches the read path, an ancestor of the
  read path, or a descendant of the read path
- structural collection edits MAY be treated conservatively as overlapping the
  whole collection subtree in phase 1

Implementations MAY over-approximate overlap. They MUST NOT miss a real overlap.

### 3.6.3 Pending-Read Resolution

Pending reads are resolved against earlier commits in the same logical session.

```typescript
function validatePendingReads(
  commit: ClientCommit,
  sessionId: SessionId,
  serverState: ServerState,
): ValidationResult {
  for (const read of commit.reads.pending) {
    const resolution = serverState.resolveLocalSeq(sessionId, read.localSeq);

    if (resolution === null) {
      return pendingDependency(read.localSeq);
    }

    if (resolution.rejected) {
      return cascadedRejection(read.localSeq);
    }
  }

  return valid();
}
```

If a referenced `localSeq` is not resolved yet, the server MAY hold the commit
in the session queue until the dependency resolves. If the dependency resolves
to rejection, the queued commit is rejected immediately.

### 3.6.4 Conflict Response

When validation fails, the server returns a `ConflictError` with enough detail
for the client to refresh confirmed state and retry.

```typescript
interface ConflictError extends Error {
  name: "ConflictError";
  commit: ClientCommit;
  conflicts: ConflictDetail[];
}

interface ConflictDetail {
  id: EntityId;
  branch: BranchId;
  path: ReadPath;
  expected: { seq: number };
  actual: {
    seq: number;
    value?: JSONValue;
  };
}
```

## 3.7 Server-Side Commit Processing

When a commit passes validation, the server applies it atomically and records it
in the commit log.

### 3.7.1 Processing Steps

1. Validate all confirmed reads.
2. Resolve all pending reads within the logical session.
3. Assign the next global `seq`.
4. Append a `commit` row containing the original payload and resolution data.
5. Append one `revision` row per operation in the transaction.
6. Update `head` pointers for touched entities.
7. Materialize or refresh snapshots as needed.
8. Mark the session-local pending commit as confirmed and enqueue session sync
   for interested sessions.

All write steps happen inside a single database transaction.

### 3.7.2 Commit Log Entry

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
  seq: number;
  branch: BranchId;
  sessionId: SessionId;
  localSeq: number;
  original: WritePayload;
  resolution: {
    seq: number;
    resolvedPendingReads?: Array<{
      localSeq: number;
      seq: number;
    }>;
  };
  invocationRef: Reference | null;
  authorizationRef: Reference | null;
}
```

The semantic JSON write path is keyed by `seq`, not by commit hash. The
content-addressed UCAN envelope is reserved for a later signed-write pass.

### 3.7.3 Seq Assignment

Seq numbers are assigned from one space-global Lamport clock. All branches share
the same seq sequence.

```text
Commit on "main":  seq 1
Commit on "main":  seq 2
Commit on "draft": seq 3
Commit on "main":  seq 4
```

All revisions produced by a single commit share the same `seq`. Revision
identity is `(branch, id, seq, opIndex)`.

### 3.7.4 Commit Identity, Signing, and Replay

Each committed write-class operation has identifiers with different roles:

- `(sessionId, localSeq)` is the optimistic identity used before acceptance and
  the idempotence key for replay
- `seq` is the canonical committed identity used after acceptance
- `invocationRef` and `authorizationRef`, when present, point at separately
  persisted signed-write metadata

On replay after reconnect:

1. the server deduplicates by `(sessionId, localSeq)`
2. it compares the replayed `original` payload with the stored `original`
3. if they match, it returns the existing commit result
4. if they differ, the replay is a protocol error

Fresh invocations or fresh authorization wrappers do not change the identity of
the underlying semantic write.

### 3.7.5 Session Identity and Reconnect

Pending-read resolution is scoped to a logical session, not to a single
WebSocket connection. The server issues a `sessionId` bound to the authenticated
client and space. The server also issues a rotating `sessionToken` that the
client must present to resume that logical session.

At most one connection may own a given logical session at a time. When a newer
connection successfully resumes a session with the current token, ownership
transfers to that connection, the old owner is revoked for that session, and
the server rotates the token. A client presenting a stale token receives
`SessionRevokedError` and must not assume it can continue replaying retained
commits on that session.

On reconnect:

1. the client resumes the logical session and reports the highest canonical
   `seenSeq` it has fully integrated, along with the latest `sessionToken`
2. the client replays retained unacknowledged commits for that session
3. the server deduplicates by `(sessionId, localSeq)`
4. the client re-establishes its watch set and receives session-scoped catch-up
   sync for any changes newer than `seenSeq`

## 3.8 Notification Ordering Guarantee

Notifications visible to the runtime scheduler must respect causal order.

### 3.8.1 Notification Types

The client provider fires three notification types:

1. `commit` — synchronous optimistic apply inside `.commit()`
2. `revert` — rollback caused by server rejection
3. `integrate` — external or newly-confirmed server data becoming visible in
   confirmed state

### 3.8.2 Ordering Rules

- A successful local commit produces exactly one synchronous `commit`
  notification.
- A rejected local commit produces a later `revert` notification before the
  promise resolves with the conflict.
- `integrate` notifications MUST be suppressed for entity paths still shadowed
  by newer local pending state.
- If multiple pending commits overlap the same entity/path, visible
  notifications MUST reflect the visible state transitions, not hidden
  intermediate states.

## 3.9 Commit Ordering

Commits are ordered by canonical `seq`.

- Pending commits are ordered locally by `localSeq`.
- Confirmed commits are ordered globally by `seq`.
- The mapping from pending to confirmed order is resolved by the server when it
  accepts the commit.

## 3.10 Atomicity Guarantees

The server applies a transaction atomically:

- either every operation produces its corresponding revision rows and head
  updates
- or none of them do

There is no partial visibility of a committed transaction.

## 3.11 Branch-Aware Commits

Ordinary commits target one branch. Validation still uses:

```text
For each confirmed read:
  there MUST NOT exist a later visible overlapping write on
  (read.branch ?? commit.branch)
  with seq > read.seq
```

Merge proposals are the special case where reads explicitly name different
branches for source, target, and base observations.

## 3.12 Client Retry Strategy

When a commit is rejected:

1. inspect the `ConflictError`
2. update confirmed state from the returned `actual` values or by fetching
   current state
3. discard the rejected pending commit and any dependent stacked commits
4. rebuild the transaction against the refreshed confirmed state
5. resubmit

The client library SHOULD support automatic retry with a bounded retry count.

## 3.13 Mapping from Current Implementation

| v1 Concept                            | v2 Concept                                        | Notes                                                         |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `cause` (hash-based CAS)              | `reads.confirmed[].seq` + path overlap validation | The client no longer sends parent hashes for JSON commits     |
| `Changes` (nested `of/the/cause` map) | `Operation[]`                                     | Simpler flat mutation list                                    |
| `Assert { is: value }`                | `SetOperation`                                    | Same root-write semantics                                     |
| `Retract { is?: void }`               | `DeleteOperation`                                 | Same root-delete semantics                                    |
| `Claim = true`                        | `reads.confirmed` / `reads.pending`               | Read dependencies moved out of operations and now carry paths |
| Pending optimistic write handles      | `(sessionId, localSeq)`                           | Session-scoped and replay-safe                                |
| Commit identity                       | `seq`                                             | Canonical ordering and lookup key after acceptance            |
