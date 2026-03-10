# Path-Granular Transactions

This document proposes an extension to transaction semantics so reads and writes
can be committed at path granularity, instead of whole-entity granularity.

## Status

Draft - proposal. This is not implemented yet.

---

## Problem

Today, transaction validation and commit operate at fact/entity granularity.

1. A read at `path: ["a", "b"]` is tracked in the runner, but commit emits an
   invariant over the whole `(of, the)` fact.
2. A write to a nested path is merged into a whole entity value and asserted as
   a full fact.
3. On the server, conflicts are detected against full fact causes, so two
   concurrent writes to non-overlapping paths still conflict.

This prevents safe concurrent writes when clients touch disjoint subtrees.

---

## Goals

1. Commit only the reads actually observed by a transaction.
2. Commit only the writes actually made by a transaction.
3. Allow concurrent commits to the same entity when touched paths do not
   overlap.
4. Preserve atomicity and deterministic conflict behavior.
5. Maintain wire-level backward compatibility during rollout.

## Non-Goals

1. Redefining fact storage from immutable facts to mutable rows.
2. Supporting arbitrary CRDT merge strategies in v1.
3. Changing schema query protocol in this proposal.

---

## Terminology

- `Entity`: `(of, the)` pair.
- `Path`: JSON path inside an entity value.
- `Read claim`: assertion that a path observed a specific value hash.
- `Write op`: path-scoped mutation operation.
- `Overlap`: two paths where one is a prefix of the other, or equal.

---

## Proposed Transaction Shape

The existing `args.changes` stays supported. New path-granular transactions add
`args.changesV2`.

```ts
type PathClaim = {
  of: URI;
  the: MIME;
  path: Array<string | number>;
  hash: string; // canonical hash of the value at path at read time
  mode?: "deep" | "shallow"; // default "deep"
};

type WriteOp =
  | {
    op: "set";
    of: URI;
    the: MIME;
    path: Array<string | number>;
    value: StorableDatum;
  }
  | {
    op: "delete";
    of: URI;
    the: MIME;
    path: Array<string | number>;
  };

type ChangesV2 = {
  claims: PathClaim[];
  writes: WriteOp[];
};
```

Notes:

1. `set` with `path: []` is equivalent to full-entity replace.
2. `delete` with `path: []` is equivalent to retract/unclaim behavior (same as
   existing root deletion semantics).
3. `hash` MUST use canonical hashing already used for value identity.

---

## Semantics

## Read Claims

At commit time, each `PathClaim` is validated against current server state:

1. Resolve `(of, the, path)` from current head fact.
2. Compute canonical hash of resolved value.
3. Compare to claimed hash.
4. On mismatch, transaction fails with conflict at that path.

Claim modes:

1. `deep`: invalidated by any overlapping write at or below path.
2. `shallow`: invalidated by writes at same path, ancestor paths, or structural
   child changes that alter keys/indices under the path.

`shallow` aligns with existing non-recursive read intent.

## Write Application

Writes are applied in order within one transaction:

1. Group writes by entity `(of, the)`.
2. Start from current entity value.
3. Apply each op in transaction order using existing path write/delete rules.
4. Resulting entity values are committed atomically with one commit record.

If two ops in the same transaction overlap, order is authoritative.

---

## Conflict Rules

A transaction fails if any claimed path is invalidated by committed state.

Two concurrent transactions `T1`, `T2` on same entity:

1. If `writes(T1)` overlaps `claims(T2)`, then `T2` may fail.
2. If `writes(T2)` overlaps `claims(T1)`, then `T1` may fail.
3. If neither overlaps, both can commit.

Overlap is prefix-based path intersection.

Examples:

1. `T1` claims `["profile","name"]`, `T2` writes `["settings","theme"]`:
   no overlap, both may commit.
2. `T1` claims `["profile"]`, `T2` writes `["profile","name"]`:
   overlap, one fails depending on order.
3. `T1` writes `["a","b"]`, `T2` writes `["a","c"]` and neither claims parent
   `["a"]`: both may commit.

---

## Server Data/Index Requirements

To make path claim validation efficient, server should maintain:

1. Current head fact per `(of,the)` (already exists).
2. Efficient path hash resolution for a head value:
   1. Either compute on demand from decoded value.
   2. Or cache subtree hashes in a path-hash index keyed by head cause.

V1 can compute on demand; indexing can be a follow-up optimization.

---

## Backward Compatibility

Server transact behavior:

1. If `changesV2` is present, use path-granular validation/application.
2. Else if `changes` is present, use current fact-granular behavior.
3. If both are present, reject unless feature flag explicitly allows dual mode
   for migration diagnostics.

Client behavior:

1. Existing clients continue sending `changes`.
2. New clients negotiate capability and send `changesV2`.

---

## Rollout Plan

1. Phase 1: Spec + capability flag (`supportsPathTransactions`).
2. Phase 2: Server support for `changesV2` behind flag.
3. Phase 3: Runner emits `changesV2` from transaction journal reads/writes.
4. Phase 4: Dual-run metrics comparing `changes` and `changesV2` conflict rates.
5. Phase 5: Default to `changesV2`, keep legacy fallback.

---

## Error Model

Add path-aware conflict payload:

```ts
type PathConflict = {
  of: URI;
  the: MIME;
  path: Array<string | number>;
  expectedHash: string;
  actualHash: string;
};
```

`ConflictError` includes one or more `PathConflict` entries.

---

## Security and Correctness

1. Path hashes must use canonical serialization to avoid representation drift.
2. Validation and write application must run in one DB transaction.
3. Commit log must record original `changesV2` for audit/replay.
4. Authorization remains at entity/fact level unless ACL evolves to path-level.

---

## Test Plan

1. Unit: claim hash/resolve correctness for object, array, holes, undefined.
2. Unit: overlap detector for equal, ancestor, descendant, disjoint paths.
3. Integration: two clients writing disjoint paths both succeed.
4. Integration: overlapping writes/read-claims conflict deterministically.
5. Regression: legacy `changes` transactions behave unchanged.

---

## Open Questions

1. Should write ops support `merge` and `array splice` in v1, or only `set` and
   `delete`?
2. Should `shallow` claim semantics be encoded explicitly, or inferred from
   transaction read metadata?
3. Should server normalize write-op order (for replay determinism), or preserve
   client order exactly?
4. Do we need path-level ACL in a follow-up spec?

---

**Previous:** [Traversal and Schema Query](./8-traversal.md)
