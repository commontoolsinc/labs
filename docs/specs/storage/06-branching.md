# Branching & Merging

## Create Branch

**Create branch:**

- Copy **heads** from the `{from}` reference — which can be:

  - `{ branch: "main", heads: [...] }`
  - `{ epoch: 12093 }`
  - `{ at: "2025-08-01T..." }`
- Insert into `branches` with `doc_id`, `name`, and `parent_branch_id` set if
  applicable.
- Initialize `am_heads(branch_id)` to copied heads, with `seq_no` matching that
  of the source branch at that point.
- No data copy — the heads reference the same underlying change DAG.

## Writes on Branch

**Writes on branch:**

- Append new changes to the branch's own `am_change_index`, incrementing
  `seq_no` locally per branch.
- Each branch has its own contiguous `seq_no` range independent of other
  branches.

## Merge

**Merge:**

- Preferred: client sends proper **merge change(s)** as part of a normal tx
  (with `baseHeads` and `mergeOf`).
- Server validates merge changes exactly like normal writes:

  - Heads and deps checked.
  - Merge source branch heads (`mergeOf`) must exist.
  - Change DAG integrity verified.
- After merge, optionally:

  - `branches.is_closed = 1`
  - `merged_into_branch_id = target branch`
- History remains in the DB for point-in-time reads.
- Multiple branches can be merged in the same tx.

### Server Merge Actor Identity (policy)

When the server synthesizes a merge (e.g., collapsing multiple heads on a single
branch), implementations may enforce a deterministic server actor identity. In
this codebase, this is guarded by an environment flag and only applies to
single-branch head collapse; cross-branch merges retain Automerge defaults.

## Genesis for new documents (clarification)

When a `(doc, branch)` is referenced for the first time, the server treats the
branch as having a virtual single head equal to `genesisHead(docId)` for
dependency validation only. No row is inserted for this head. The first accepted
client change must list this `genesisHead(docId)` as a dependency; otherwise the
write is rejected as an incorrect genesis.
