# 6. Branching

This section defines how branches provide isolated lines of development within
a Space. Branches enable speculative writes, feature development, and undo/redo
without affecting the main line of data.

## 6.1 Default Branch

Every Space has an implicit **default branch** with canonical branch name `""`
(empty string). It is the target for all operations that do not specify a
branch explicitly.

- The default branch is created automatically when the Space is initialized.
- It cannot be deleted.
- It has no parent branch and no fork point -- it is the root of all branch
  history.
- Clients MAY display this branch as `"main"` in UI, but protocol/storage use
  `""`.

```typescript
const DEFAULT_BRANCH = "";
```

---

## 6.2 Branch Data Model

A branch is a lightweight pointer into the shared fact history. Branches do not
copy data -- they share the same fact log and entity history as every other
branch in the Space. What differs between branches is their **head table**: the
mapping from entity id to the current head fact for that entity.

```typescript
interface Branch {
  name: BranchName;              // Unique name within the space
  parentBranch: BranchName;      // Branch this was forked from
  forkSeq: number;               // Seq at which the fork occurred
  createdSeq: number;            // Seq at which this branch name came into existence
  headSeq: number;               // Latest seq at which this branch's visible state was updated
  createdAt: number;             // Timestamp of branch creation
  status: "active" | "deleted";  // Soft-delete flag
}

type BranchName = string;
```

### 6.2.1 Head Table

Each branch has its own head table that maps entity ids to their current state
on that branch:

```typescript
// Conceptual schema for the branch-scoped head table
interface BranchHead {
  branch: BranchName;
  entityId: EntityId;
  factHash: Reference;      // Hash of the current head fact
  seq: number;              // Seq at which this head was set
}
```

At branch creation time, the new branch's head table is a logical copy of the
parent branch's head table at the fork seq. No physical copy occurs -- the
server resolves heads by checking the branch's own head table first, then
falling back to the parent branch's heads at the fork seq.

### 6.2.2 Storage Implications

Because branches share the fact history:

- **Fact storage is append-only and shared.** A fact committed on branch A is
  physically the same fact if it appears on branch B.
- **Branch creation is O(1).** No data is copied. Only a `Branch` metadata
  record is created.
- **Branch deletion is O(1).** The branch metadata is marked `status: "deleted"`.
  Facts are not removed because they may be shared with other branches.

See `02-storage.md` for the physical table layouts that support this model.

---

## 6.3 Branch Creation

A new branch is created from an existing branch at a specific seq.

Branch creation is a **write-class** command even though it does not emit any
entity facts. It is serialized with ordinary `/memory/transact` writes, uses
`localSeq` for replay safety, receives a global `seq`, and records a commit-log
entry for audit/idempotence.

### 6.3.1 API

```typescript
interface CreateBranchRequest {
  localSeq: number;              // Session-scoped idempotence key
  name: BranchName;              // Must be unique within the space
  fromBranch?: BranchName;       // Default: default branch
  atSeq?: number;                // Default: headSeq of fromBranch
}

interface CreateBranchResult {
  branch: Branch;
  seq: number;                   // Global seq assigned to this branch-lifecycle write
}
```

### 6.3.2 Semantics

When `branch.create({ localSeq, name, fromBranch, atSeq })` is called:

1. **Validate** that `name` does not already exist (including soft-deleted
   branches -- names are permanently consumed).
2. **Resolve the parent branch.** If `fromBranch` is omitted, use the default
   branch.
3. **Resolve the fork seq.** If `atSeq` is omitted, use the parent
   branch's current `headSeq`. If `atSeq` is specified, it must be
   <= the parent branch's `headSeq`.
4. **Append a sequenced branch-lifecycle write.** The server assigns a new
   global `seq`, records a commit-log entry for this successful command, and
   applies the branch metadata mutation atomically with that log insert.
5. **Create the `Branch` record:**
   ```
     Branch {
       name: name,
       parentBranch: fromBranch,
       forkSeq: atSeq,
       createdSeq: seq,
       headSeq: seq,
       createdAt: now(),
       status: "active"
     }
   ```
6. The new branch starts with the same entity heads as the parent branch at the
   fork seq. No head records are physically copied -- head resolution falls
   back to the parent (see 6.2.1).
7. The branch-creation command's own `seq` becomes both `createdSeq` and the
   initial `headSeq`, because it makes the inherited fork-state visible under
   the new branch name.

### 6.3.3 Fork from a Fork

Branches can be created from other non-default branches. The `parentBranch`
field always points to the immediate parent, forming a tree of branches. Head
resolution follows the parent chain: a branch's effective head for an entity is
the first explicit head found walking from the branch up through its parent
chain to the fork points.

---

## 6.4 Writing to Branches

Commits always target a specific branch. The commit model defined in
`03-commit-model.md` applies identically to branches, with one key difference:
the head table is scoped to the target branch.

### 6.4.1 Commit Targeting

```typescript
type BranchCommit = ClientCommit & {
  branch?: BranchName;   // Omit for default branch
};
```

### 6.4.2 Validation

Ordinary entity writes on branches use the same validation rule as any other
`ClientCommit`:

```
For each confirmed read in the commit:
  there MUST NOT exist a later visible overlapping write on
  (read.branch ?? commit.branch)
  whose seq is > read.seq
```

For normal branch writes, `read.branch` is omitted, so reads validate against
the target branch's visible state. Merge proposals are the special case: they
set `read.branch` explicitly for source/target/base observations. Two branches
can independently modify the same entity without conflict until a merge is
attempted.

### 6.4.3 Seq Assignment

All branches share the Space's global seq counter (Lamport clock). Every
write-class command advances the global seq. Branch creation sets both
`createdSeq` and the initial `headSeq`. Thereafter, entity-state writes
(`/memory/transact`, including merge materialization) advance `headSeq`, while
branch deletion does not. This ensures seqs are globally ordered across all
branches, which is essential for point-in-time queries.

```
branch.create("feature-x"):
  globalSeq++
  branch["feature-x"].createdSeq = globalSeq
  branch["feature-x"].headSeq = globalSeq

entity-state commit on branch "feature-x":
  globalSeq++
  for each fact in commit:
    fact.seq = globalSeq
  branch["feature-x"].headSeq = globalSeq
```

---

## 6.5 Reading from Branches

Queries target a branch via the `branch` field in `QueryOptions` (see
`05-queries.md`). All query types -- simple, schema, point-in-time, and
subscriptions -- respect the branch scope.

### 6.5.1 Head Resolution

When reading an entity on a branch:

1. Check the branch's own head table for an explicit head entry.
2. If not found, check the parent branch's head table at the fork seq.
3. Recurse up the parent chain until a head is found or the default branch is
   reached.

```
resolveHead(branch, entityId):
  head = branch.heads[entityId]
  if head exists and head.seq <= branch.headSeq:
    return head
  if branch.parentBranch exists:
    // Only consider parent's state at or before the fork point
    return resolveHead(branch.parentBranch, entityId,
                       atSeq = branch.forkSeq)
  return null  // Entity does not exist
```

#### Head Resolution Caching

When a head is resolved by falling back to the parent branch, the resolved head
MAY be cached in the child branch's head table to avoid repeated parent lookups.
This cache entry is written lazily on first read, not eagerly at branch creation
time. Subsequent reads for the same entity on the same branch hit the cache
directly, turning a multi-hop parent chain walk into a single local lookup.

### 6.5.2 Subscriptions on Branches

Subscriptions can target a specific branch. The server sends updates when
entities on that branch change. Commits on other branches do not trigger updates
for a branch-scoped subscription.

---

## 6.6 Branch Isolation

Writes to branch A are **invisible** to branch B until a merge is performed.
This isolation guarantee is fundamental and absolute:

- A query on branch B will never return facts committed on branch A (unless they
  were committed on a common ancestor before both branches forked).
- A subscription on branch B will never be notified of commits on branch A.
- The only way for branch A's changes to become visible on branch B is through
  an explicit merge operation (6.7).

### 6.6.1 Shared History

While branches are isolated going forward from the fork point, they share all
history prior to the fork. Facts committed before `forkSeq` are visible on
both the parent and child branch.

```
Timeline:
  v1 ---- v2 ---- v3 ---- v4 ---- v5      (default branch)
                    |
                    +--- v6 ---- v7          (feature branch, forked at v3)

- Query on default branch sees: v1..v5
- Query on feature branch sees: v1..v3, v6..v7
- v4 and v5 are invisible to the feature branch
- v6 and v7 are invisible to the default branch
```

---

## 6.7 Merging

Merging integrates changes from a source branch into a target branch. The merge
operates at the **entity level** -- each entity is considered independently.

### 6.7.1 Merge API

```typescript
interface MergeRequest {
  source: BranchName;     // Branch to merge from
  target: BranchName;     // Branch to merge into
}

interface MergeResult {
  status: "ready" | "conflict";
  proposal?: MergeProposal;       // Client adds localSeq, then transacts
  merged?: number;                // Number of entities to materialize
  conflicts?: BranchConflict[];   // Conflicting entities (on conflict)
  sourceSeq: number;
  baseBranch: BranchName;
  baseSeq: number;
}
```

### 6.7.2 Merge Algorithm

The merge compares each entity's state on source and target relative to their
**merge base** (nearest common ancestor in the branch tree).

```
merge(source, target):
  base = findMergeBase(source, target)
  baseSeq = base.seq
  conflicts = []
  fastForwards = []

  // Entities changed on source since merge base
  for each entity modified on source since baseSeq:
    sourceHead = resolveHead(source, entity)
    targetHead = resolveHead(target, entity)
    baseHead = resolveHeadAtSeq(base.branch, entity, baseSeq)

    if targetHead == baseHead:
      // Target unchanged since base -> adopt source change
      fastForwards.push({ entity, newHead: sourceHead })

    else if sourceHead == baseHead:
      // Source effectively unchanged since base
      // Nothing to do

    else:
      // Both changed since base -> conflict
      conflicts.push({
        entityId: entity,
        sourceValue: sourceHead.value,
        targetValue: targetHead.value,
        ancestorValue: baseHead.value
      })

  if conflicts.length > 0:
    return {
      status: "conflict",
      conflicts,
      sourceSeq: source.headSeq,
      baseBranch: base.branch,
      baseSeq,
    }

  proposal = buildMergeProposal(target, fastForwards, source, base)
  return {
    status: "ready",
    proposal,
    merged: fastForwards.length,
    sourceSeq: source.headSeq,
    baseBranch: base.branch,
    baseSeq,
  }
```

### 6.7.3 Fast-Forward

When only the source branch has modified an entity, the target branch
fast-forwards by materializing the source branch's visible state as an ordinary
write on the target branch at the merge seq. In the baseline implementation:

- If the source branch currently shows a live value, the merge transaction emits
  a `set` on the target branch with that value.
- If the source branch currently shows a tombstone, the merge transaction emits
  a `delete` on the target branch.

This keeps merge as a regular signed transaction, keeps point-in-time reads
simple, and avoids a separate "adopt existing fact" mutation path. Reusing
source facts directly can be added later as an optimization if needed.

### 6.7.4 CRDT Merge (Future Extension)

For entities that carry commutative, convergent data structures (CRDTs), the
merge algorithm could apply type-specific merge functions instead of reporting
conflicts. This would require schema annotations declaring an entity's merge
strategy (e.g., `"x-merge-strategy": "counter"` or `"x-merge-strategy":
"lww-register"`). This extension is not part of the current specification but
is noted as a natural evolution of the merge system.

### 6.7.5 Merge Transaction

A successful merge is finalized by submitting a **normal transaction** on the
target branch. The merge API prepares a `MergeProposal`; the client adds its
next `localSeq` and submits the resulting `ClientCommit` via `/memory/transact`.

The prepared `MergeProposal` carries:

- `branch = target`
- `merge = { sourceBranch, sourceSeq, baseBranch, baseSeq }`
- Confirmed reads for the source/target/base heads used to compute the merge,
  with each read's optional `branch` field set explicitly to the branch where
  that observation was made
- `pending = []` because the proposal is computed against confirmed branch state
- One ordinary `set`/`delete` operation per merged entity

There are no special non-transaction commits for merge. The resulting commit is
signed, hashed, sequenced, stored, and replayed through the same path as any
other client transaction.

At apply time, the server re-validates those branch-scoped confirmed reads on
their original branches. This means the proposal becomes stale if the source
branch, target branch, or merge-base branch observation it depended on has
changed since the proposal was prepared.

Clients SHOULD request merge when they do not have outstanding local pending
writes on the source or target branch. If a caller needs to stack a merge on top
of local pending work, it must rebuild the proposal against that local state
before submission.

---

## 6.8 Conflict Resolution

When a merge detects conflicts (both branches modified the same entity), the
server returns the conflicts to the client for resolution.

### 6.8.1 Conflict Structure

```typescript
interface BranchConflict {
  entityId: EntityId;
  sourceValue: JSONValue | null;    // Value on source branch (null = deleted)
  targetValue: JSONValue | null;    // Value on target branch (null = deleted)
  ancestorValue: JSONValue | null;  // Value at fork point (null = didn't exist)
  sourceSeq: number;                // Seq of source's head fact
  targetSeq: number;                // Seq of target's head fact
}
```

### 6.8.2 Resolution Protocol

To resolve conflicts, the client:

1. Inspects each `BranchConflict` to understand the divergence.
2. Decides on a resolution value for each conflicting entity.
3. Re-runs the merge with inline `resolutions`, or constructs the merge
   transaction directly.
4. Adds the next `localSeq` and submits the resulting `ClientCommit` on the
   **target branch**.

The resulting merge transaction materializes the remaining non-conflicting
source changes plus the explicit resolution values chosen for the conflicting
entities, all on the target branch.

Alternatively, the client can resolve all conflicts in a single step by
committing the resolutions and immediately retrying the merge with a flag:

```typescript
interface MergeRequest {
  source: BranchName;
  target: BranchName;
  resolutions?: Record<EntityId, JSONValue | null>;  // Inline resolutions
}
```

When `resolutions` is provided, the merge folds those values into the generated
merge transaction so the final `/memory/transact` can resolve all conflicts
atomically.

### 6.8.3 Conflict Granularity

Conflicts are detected at the **entity level**, not at the field or line level.
If both branches modify the same entity, even if they modify different fields,
it is reported as a conflict. This is a deliberate simplicity trade-off:

- Entity-level conflicts are simple to reason about and implement.
- Field-level merge would require understanding the schema and patch semantics.
- Clients that want field-level merge can implement it in their resolution logic
  by diffing the ancestor, source, and target values.

---

## 6.9 Branch Deletion

Branches are soft-deleted. The branch metadata is marked as `status: "deleted"`,
but the branch record and its fact history remain.

Branch deletion is also a **write-class** command. Like branch creation, it is
serialized with ordinary writes, uses `localSeq` for replay safety, receives a
global `seq`, and records a commit-log entry even though it does not emit
entity facts.

### 6.9.1 API

```typescript
interface DeleteBranchRequest {
  localSeq: number;
  name: BranchName;
}

interface DeleteBranchResult {
  seq: number;
}
```

### 6.9.2 Semantics

- The default branch cannot be deleted.
- A deleted branch cannot be written to or used as a merge target.
- Ordinary reads and point-in-time reads against a deleted branch remain valid
  for historical inspection and lineage traversal.
- A deleted branch MAY still be used as a merge source, because that is a
  read-only operation over preserved history.
- `subscribe: true` on a deleted branch returns the current historical result as
  a finite snapshot and then produces no future updates, because the branch can
  no longer advance.
- The branch-deletion command's own `seq` does **not** advance `headSeq`,
  because it changes branch metadata but not the branch-visible entity state.
- The branch name is permanently consumed -- a new branch with the same name
  cannot be created.
- Facts committed on the branch remain in the shared fact history. They may be
  referenced by other branches or by point-in-time queries that target a seq
  before the deletion.
- Child branches (branches forked from the deleted branch) remain functional.
  Their `parentBranch` reference still points to the deleted branch, and head
  resolution still works because the deleted branch's head table is preserved.

---

## 6.10 Point-in-Time Reads on Branches

Point-in-time queries (see `05-queries.md` section 5.5) compose naturally with
branches:

```typescript
interface BranchPointInTimeQuery extends QueryOptions {
  branch: BranchName;
  atSeq: number;
}
```

### 6.10.1 Semantics

`queryGraph({ branch: "feature-x", atSeq: 42, subscribe: false })` reads the
state of the `feature-x` branch as it was at seq 42:

1. **Seq bounds**: `atSeq` must be within the branch's seq range.
   - For the default branch, any seq from 0 to `headSeq` is valid.
   - For a non-default branch, valid seqs are those in the range
     `[createdSeq, headSeq]`. A query before `createdSeq` is invalid because
     the branch name did not exist yet.
2. **Reconstruction**: the reconstruction algorithm from `05-queries.md` section
   5.5 applies, scoped to the branch. Only facts committed on the branch (or
   inherited from ancestors before fork) with seq <= `atSeq` are considered.
   Even though the branch may have been created later than `forkSeq`, inherited
   parent facts are still capped at `forkSeq` when reconstructing the branch's
   visible state.
   Because merge results are materialized as ordinary target-branch writes, no
   extra merge-only read path is required.

### 6.10.2 Interaction with Merge Commits

After a merge, the target branch exposes the merged state starting at the merge
seq because the merge transaction wrote ordinary facts on the target branch at
that seq. A point-in-time query at a seq before the merge will not see those
facts; a query at or after the merge seq will.

---

## 6.11 Branch Listing

Clients can list all branches in a Space to discover available branches and
their metadata.

### 6.11.1 API

```typescript
interface ListBranchesRequest {
  includeDeleted?: boolean;   // Default: false
}

interface ListBranchesResult {
  branches: BranchInfo[];
}

interface BranchInfo {
  name: BranchName;
  parentBranch: BranchName;
  forkSeq: number;
  createdSeq: number;
  headSeq: number;
  createdAt: number;
  status: "active" | "deleted";
  deletedAt?: number;
  entityCount?: number;        // Number of entities with explicit heads
}
```

---

## 6.12 Use Cases

### 6.12.1 Feature Branches for Patterns

A pattern can create a branch to develop a new feature without affecting the
live data:

```
1. branch.create({ localSeq: nextLocalSeq(), name: "draft-v2" })
2. commit({ branch: "draft-v2", operations: [...] })  // iterate on design
3. commit({ branch: "draft-v2", operations: [...] })  // more changes
4. proposal = merge({ source: "draft-v2", target: "main" })
5. commit({ localSeq: nextLocalSeq(), ...proposal })   // ship it
6. branch.delete({ localSeq: nextLocalSeq(), name: "draft-v2" }) // clean up
```

### 6.12.2 Undo/Redo via Branching

Branches provide a natural undo mechanism. Before a risky operation, create a
branch:

```
1. branch.create({ localSeq: nextLocalSeq(), name: "before-migration" }) // save point
2. commit({ operations: [... migration ...] })   // run migration on main
3. // If migration was wrong:
   merge({ source: "before-migration", target: "main" })  // revert
```

Or more precisely, read the pre-migration state from the branch and write it
back to main.

### 6.12.3 Speculative Execution

An LLM-driven pattern can use branches for speculative exploration:

```
1. branch.create({ localSeq: nextLocalSeq(), name: "speculation-1" })
2. branch.create({ localSeq: nextLocalSeq(), name: "speculation-2" })
3. // Run different strategies in parallel on each branch
4. // Evaluate results
5. // Merge the winning branch
6. merge({ source: "speculation-1", target: "main" })
7. branch.delete({ localSeq: nextLocalSeq(), name: "speculation-1" })
8. branch.delete({ localSeq: nextLocalSeq(), name: "speculation-2" })
```

### 6.12.4 Collaborative Editing

Multiple users can work on separate branches and merge their changes:

```
1. branch.create({ localSeq: nextLocalSeq(), name: "alice-edits" })
2. branch.create({ localSeq: nextLocalSeq(), name: "bob-edits" })
3. // Alice and Bob work independently
4. merge({ source: "alice-edits", target: "main" })    // Alice merges first
5. merge({ source: "bob-edits", target: "main" })      // Bob may hit conflicts
6. // Bob resolves conflicts, re-merges
```

---

## 6.13 Branch Depth and Performance

Head resolution walks the parent chain (see 6.5.1). When branches are created
from other branches (fork from a fork), the parent chain grows deeper. Deep
chains degrade read performance because each head lookup may require traversing
multiple parent branches before finding an explicit head entry.

### 6.13.1 Depth Limits

The server SHOULD limit branch depth to **8 levels**. The server MAY reject
branch creation requests that would exceed this depth with an error indicating
that the maximum branch depth has been reached.

### 6.13.2 Materialization (Rebasing)

As an alternative to hard depth limits, the server can periodically
**materialize** (snapshot) a branch's heads. Materialization copies all resolved
heads from parent branches into the branch's own head table, effectively
"rebasing" the branch and eliminating the need to walk the parent chain. After
materialization, head resolution for the branch is O(1) regardless of the
original chain depth.

Materialization is transparent to clients -- it does not change the logical
state of the branch, only its physical storage.

---

## 6.14 Branch Diff

The branch diff operation compares entity state between two branches, useful for
code-review-style workflows and pre-merge inspection.

### 6.14.1 API

```typescript
interface DiffRequest {
  source: BranchName;
  target: BranchName;
}

interface DiffResult {
  added: EntityId[];      // Entities on source but not target
  removed: EntityId[];    // Entities on target but not source
  modified: EntityId[];   // Entities changed on both
}
```

### 6.14.2 Semantics

The diff is computed relative to the common ancestor (fork point) of the two
branches. An entity is **added** if it exists on the source but not at the
common ancestor or on the target. An entity is **removed** if it exists on the
target but was deleted on the source. An entity is **modified** if both branches
have a different head for it compared to the ancestor.
