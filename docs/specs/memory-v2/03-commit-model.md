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
// Shown at module scope.
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
path-targeted edits whose leaf values use the shared FabricValue surface, not
just a JSON subset.

## 3.2 Transaction Structure

A transaction groups one or more operations into an atomic unit. All operations
succeed or all fail.

```typescript
// Shown at module scope.
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
// Shown at module scope.
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
  // The dependency set: every pending layer the read's materialized view
  // sat on. Each element must have resolved to an ACCEPTED commit for this
  // commit to be applicable; the staleness check (§3.6.1) runs once per
  // read, from the basis §3.6.3 selects. A scalar is the single-layer
  // form, and the only form a client may send to a server that has not
  // advertised the `pendingReadStacks` capability in the hello exchange.
  localSeq: number | number[];
  // The reader's confirmed basis for THIS document, in the SERVER's seq
  // space: the seq of the last accepted write to the document that the
  // client's confirmed view reflected at build time (0 for a document its
  // subscriptions never covered). When present, the staleness check scans
  // the FULL interval from this basis, excluding only the session's TRUE
  // PREDECESSOR commits — localSeq below the reader's — per §3.6.3 (the
  // CT-1910 repair). When absent (a legacy client),
  // staleness is based at the resolution of the HIGHEST localSeq element —
  // the document's top-of-stack layer below the reader, which the array
  // MUST include (§3.5). Servers ignore unknown fields, so clients attach
  // this unconditionally; older servers keep the legacy basis.
  basisSeq?: number;
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

The cascade cannot rely on each pending layer reading the layer beneath it:
zero-read operations (mergeable collection writes) legally interleave into a
stack without any read edge. A commit that reads through a pending stack
therefore records its FULL dependency set directly: the read's `localSeq`
array names every pending layer of the document below the reader, in
ascending order. Each element imposes a resolution requirement; the highest
element — the document's top-of-stack layer — is the legacy staleness basis
when no `basisSeq` is declared (§3.6.3). The
client mirrors the server cascade at drop time: when a pending commit's
optimistic writes are dropped, every queued or in-flight commit whose
recorded dependency set names the dropped `localSeq` is locally rejected
without waiting for the server's per-commit verdict.

The dependency array MUST include the document's top-of-stack pending layer
below the reader. For a read that declares no `basisSeq`, the staleness
basis is the stack top (implicitly, the array's highest element), and basing
the scan at a lower layer is unsound, not merely conservative: the session's
own newer stacked commits then land inside the scan interval, where the
path-blind set/delete check false-conflicts with the reader's own stack. A
read that declares `basisSeq` does not have this constraint on its basis —
own-session exclusion (§3.6.3) removes the self-conflict, which is exactly
what lets the scan start at the true confirmed basis — but the top-of-stack
element remains REQUIRED in the array for its resolution edge. Any narrowing
of the dependency set (for example, pruning layers whose write footprint
provably cannot influence the read path) may drop only NON-top layers.

The array form is a negotiated capability (`pendingReadStacks` in the hello
flags). Toward a server that does not advertise it, the client MUST send
scalar reads, collapsing each array to its top-of-stack element — the
pre-capability wire shape. Because the omitted lower layers are then
invisible to the server, the client MUST NOT send such a commit while any
omitted dependency is unsettled: the server could durably accept a commit
the client is about to cascade-reject, and the caller would observe a
conflict for a write that landed. The client holds the send until every
omitted dependency settles — a dropped one dooms the commit locally before
it reaches the wire, and all-accepted makes the scalar shape sound (each
omitted layer's resolution is already durable). Scheduler observations,
being droppable bookkeeping, degrade instead of holding: an observation
whose read sat on more than one pending layer is dropped client-side
(flag-off semantics — the resume re-runs fresh) rather than delaying the
flush that semantic commits await.

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
// Shown inside a pattern body.
function validatePendingReads(
  commit: ClientCommit,
  sessionId: SessionId,
  serverState: ServerState,
): ValidationResult {
  for (const read of commit.reads.pending) {
    const layers = Array.isArray(read.localSeq)
      ? read.localSeq
      : [read.localSeq];

    // Every listed layer must resolve to an ACCEPTED commit. The staleness
    // check (§3.6.1/§3.6.2) then runs once per read, from the basis this
    // section selects below (declared `basisSeq`, or the legacy highest
    // element's resolution).
    for (const localSeq of layers) {
      const resolution = serverState.resolveLocalSeq(sessionId, localSeq);

      if (resolution === null) {
        return pendingDependency(localSeq);
      }

      if (resolution.rejected) {
        return cascadedRejection(localSeq);
      }
    }
  }

  return valid();
}
```

If a referenced `localSeq` is not resolved yet, the server MAY hold the commit
in the session queue until the dependency resolves. If the dependency resolves
to rejection, the queued commit is rejected immediately.

Holding is queueing, not reordering: within a logical session, commits are
resolved (accepted or rejected) in increasing `localSeq` order, and a held
commit MUST NOT be leapfrogged by a later same-session commit. A commit's
resolution seq is therefore monotonic in its `localSeq` within a session —
the property that makes the top-of-stack pending read a sound LEGACY
staleness basis (§3.5): every own-session layer below the reader resolves at
or before the basis layer's seq, so the scan interval past the basis
contains no own-session commits. (The current implementation rejects rather
than holds, which preserves this ordering trivially.) A `basisSeq` read does
NOT lean on this ordering: its own-session exclusion checks each excluded
commit's `localSeq` directly, so an own commit admitted out of submission
order simply conflicts.

Every element of an array `localSeq` participates in this resolution
requirement — one unresolved or rejected element rejects the commit. The
staleness scan (§3.6.1/§3.6.2) then runs once per read, from a basis chosen
by the read's shape:

- **True basis (`basisSeq` present).** The scan covers the full interval
  `(basisSeq, head]` and excludes only the reader's own session's TRUE
  PREDECESSOR commits — those with `localSeq` below the reader's, the
  accepted layers its materialized view included. The exclusion is what
  makes the true basis sound, and its predecessor restriction is what keeps
  it sound without trusting wire order: an own write with a higher
  `localSeq` that was admitted first (an out-of-order submission) was not
  in the reader's view and conflicts exactly like a foreign write. Foreign
  writes in the interval conflict — including those between the reader's
  confirmed basis and the top layer's resolution seq, which the legacy
  basis never scanned. A `basisSeq` greater than the server's current head
  is a protocol error; values at or below head are trusted, like a
  confirmed read's `seq` (lying corrupts only the session's own data).
- **Legacy basis (`basisSeq` absent).** The scan is based at the HIGHEST
  element's resolution seq. Writes landing between the reader's confirmed
  basis and that seq are not scanned — the pending-read basis over-advance
  (CT-1910), retained verbatim for old clients and recorded as an INV-1
  known deviation in `09-invariants.md`. The deviation retires when clients
  that omit `basisSeq` do.

### 3.6.4 Conflict Response

When validation fails, the server rejects the commit with a `ConflictError` and
stages the repair for delivery through the sync stream.

```typescript
// Shown at module scope.
interface ConflictError extends Error {
  name: "ConflictError";
  /**
   * Server head seq at rejection time. Carried for diagnostics; a sync window
   * reaching this seq reflects the winning write.
   */
  retryAfterSeq: number;
}
```

The rejection carries no document values. Instead the server marks the commit's
write targets and both read sets (`reads.confirmed` and `reads.pending`) dirty
for the session — origin-less, so the session's own echo suppression does not
hide them — and the next sync frame delivers the current documents for all of
them as ordinary upserts. Repair therefore arrives as a consistent cut over the
session's watched view — covering stale read dependencies as well as write
targets, with every document the frame links to delivered in the same cut.

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
// Shown at module scope.
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

When a commit is rejected with a `ConflictError`:

1. discard the rejected pending commit and any dependent stacked commits
2. wait for the repair sync: the catch-up marker covering the rejected commit
   (`caughtUpLocalSeq` reaching its `localSeq`), whose frame delivers current
   documents for the commit's write targets and read sets (§3.6.4)
3. rebuild the transaction against the repaired confirmed state
4. resubmit

Conflict retries are event-gated, not counted: every conflict raised against a
repaired read set proves a newer overlapping write, so each round makes
progress, and waiting on the repair frame bounds the loop without a retry
budget. Rejections other than `ConflictError` are terminal for the failing run
— re-running against an unchanged replica recomputes the identical refused
write. Recovery is owned by reactivity: any server-side change that could make
the operation valid overlaps state the client subscribes to, and its arrival
re-triggers the computation.

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
