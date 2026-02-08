# Architecture Review: Memory v2 Specification

**Reviewer role**: Systems architect
**Date**: 2026-02-07
**Scope**: All sections (README, 01-06), cross-referenced with verifiable-execution spec

---

## 1. Critical Gaps

### 1.1 Version-Based Validation Is Dangerously Permissive

The validation rule in 03-commit-model.md (section 3.6.1) is:

```
commit.reads.confirmed[i].version >= server.head[entity].version
```

This is described as "strictly weaker than CAS" and positioned as a benefit. It is actually a correctness hazard. The direction of the inequality allows **stale reads to pass validation**. If my read is at version 10 and the server head is at version 8, the commit succeeds -- but my read is *newer* than the server's head, which should be impossible in a well-ordered system (how did I read version 10 if the server is at 8?). This suggests the inequality is backwards.

The intended semantics appear to be "my read is not stale" which should be:

```
commit.reads.confirmed[i].version >= server.head[entity].version
```

But wait -- this is exactly what's written. The problem is that if the server's head advances *past* my read version, my commit should fail, but the rule says my version must be `>=` the server's. If the server is at version 12 and I read version 10, then `10 >= 12` is false, so the commit is rejected. OK, the rule is correct for the basic case.

However, the rule is still too permissive compared to CAS in a subtle way: it allows **lost updates**. Consider:

1. Client A reads entity X at version 5 (value: `{count: 10}`)
2. Client B writes entity X at version 6, setting `{count: 20}`. Server head is now version 6.
3. Client A submits a write to entity X with read version 5 against server head version 6.
4. `5 >= 6` is false -- rejected. Good.

But consider a different scenario with version-based (not hash-based) comparison:

1. Client A reads entity X at version 5 (value: `{count: 10}`)
2. Client B writes entity X at version 6, setting `{count: 20}`
3. Client A **also** reads entity Y at version 6 as part of the same session
4. Client A submits a commit that reads X at version 5 and writes Y
5. For X: `5 >= 6` is false -- rejected correctly

OK, so the directional check works. But there is a subtler issue: the spec says the validation checks `read.version >= server.head[entity].version`, but `Operation` types carry a `parent: Reference` (hash), not a version number. How does the server get the version for the read? The `ClientCommit` has `ConfirmedRead` which carries both `hash` and `version`. But what if the client lies about the version (claims version 10 when they actually read version 5)? The server would need to verify the hash corresponds to the claimed version. The spec does not describe this cross-check.

**Recommendation**: Explicitly specify that the server MUST verify `hash` corresponds to `version` for each confirmed read (a simple index lookup). Without this, the version-based check is trivially bypassable.

### 1.2 No Garbage Collection Strategy for Facts

The fact table is append-only and never pruned. For long-lived, high-write entities this is a real problem:

- A chat-like entity with 100K patches creates 100K fact rows
- Point-in-time reads at early versions require replaying from genesis (or the first snapshot)
- The blob table will accumulate patch operation JSON blobs that may never be read again
- No compaction or archival strategy is mentioned

Snapshots partially address read performance but do nothing for storage growth. The spec should at minimum discuss:

- Fact compaction (replacing a sequence of patches with a single set fact + tombstoning old facts)
- Cold storage tiers (move old facts to separate storage)
- Space-level retention policies
- blob table cleanup (orphaned blobs after compaction)

### 1.3 Branch Head Resolution Is O(depth) With No Bound

Section 6.5.1 defines head resolution as recursive through the parent chain:

```
resolveHead(branch, entityId):
  head = branch.heads[entityId]
  if not found:
    return resolveHead(branch.parentBranch, entityId, atVersion = branch.forkVersion)
```

There is no limit on branch nesting depth. A chain of 100 branches would require 100 lookups to resolve a single entity head (worst case). Combined with the "Fork from a Fork" feature (6.3.3), this creates an unbounded performance degradation path.

**Recommendation**: Either (a) cap branch depth, (b) eagerly materialize heads on branch creation (trading O(1) creation for O(entities) creation cost but O(1) reads), or (c) lazily materialize heads on first read with caching.

### 1.4 Contradictory Branch Creation Semantics Between 02-storage and 06-branching

`02-storage.md` section 7.1 physically copies all head pointers on branch creation:

```sql
INSERT INTO head (branch, id, fact_hash)
SELECT :branch_name, h.id, h.fact_hash
FROM head h
WHERE h.branch = :parent_branch;
```

`06-branching.md` section 6.2.2 says:

> Branch creation is O(1). No data is copied.

And section 6.3.2 says:

> No head records are physically copied -- head resolution falls back to the parent

These are contradictory. The SQL in 02-storage copies all heads (O(n) in entity count). The prose in 06-branching claims O(1) with lazy fallback. These cannot both be true. The spec must pick one and update the other.

If you choose lazy resolution (O(1) creation), the SQL in 02-storage and the `head` table semantics need to change -- you would need to look up parent branch heads on cache miss.

If you choose eager copy (the SQL approach), the O(1) claim is false and 06-branching needs correction.

### 1.5 Missing Protocol Bindings for Branch Lifecycle

The README acknowledges this as open item #4, but it bears repeating: `04-protocol.md` has zero commands for branch create/merge/delete/list. This is not a minor omission -- without protocol bindings, branches are unimplementable by a client.

### 1.6 Point-in-Time Reads on Branches Do Not Filter by Branch

The point-in-time read SQL in `02-storage.md` section 5.2 does not filter by branch:

```sql
SELECT f.hash, f.fact_type, f.version, b.data
FROM fact f
JOIN blob b ON b.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.version <= :target_version
ORDER BY f.version DESC
LIMIT 1;
```

This query returns the latest fact for an entity across ALL branches, not scoped to the target branch. The branch-aware query in section 8.2 partially addresses this with a subquery, but that query uses `IN (SELECT hash FROM commit WHERE branch = :branch_name)` which is a correlated subquery that will be slow on large commit tables.

The fact table has no `branch` column, which means branch-scoped queries always require joining through `commit`. This is an architectural decision that trades write simplicity (no branch column on facts) for read complexity. The trade-off should be explicitly acknowledged, and the performance implications discussed.

**Recommendation**: Add a `branch` column to the fact table (denormalized from commit) and index it. The write overhead is trivial (one extra column per insert); the read benefit is significant.

---

## 2. Performance Risks

### 2.1 Patch Replay Scaling

An entity with N patches since the last snapshot requires O(N) JSON parse + apply operations to read. The default snapshot interval is 10 patches, but:

- What if snapshot creation fails or is deferred?
- What if patches are large (each patch adds 100 array elements via splice)?
- What if many clients read the same entity between snapshots?

The spec should discuss:

- Maximum patch replay depth (hard cap with forced snapshot)
- Caching of materialized values (in-memory LRU above the snapshot layer)
- Async snapshot creation (so writes aren't blocked by snapshot materialization)

### 2.2 Wildcard Queries on Large Spaces

The `"*"` wildcard in simple queries (05-queries.md section 5.2.1) iterates all entities on a branch. For a space with 1M entities, this is a full table scan. The spec mentions pagination (5.8) but doesn't discuss:

- Whether wildcard queries are even allowed without pagination
- Maximum result set size limits
- Whether the server can reject unbounded wildcards

### 2.3 Schema Traversal Unbounded Fan-Out

Schema queries can recursively follow references. If entity A references 100 entities, each of which references 100 more, a single schema query could touch 10,000+ entities. The spec mentions cycle detection but not fan-out limits.

**Recommendation**: Add a configurable `maxDepth` and `maxEntities` parameter to schema queries, with server-enforced defaults.

### 2.4 SQLite Single-Writer Bottleneck

SQLite WAL mode allows concurrent reads during a single write, but writes are still serialized. The spec says "Transactions on different branches are independent and can proceed in parallel" (03-commit-model.md section 3.9), but with a single SQLite database per space, all writes to all branches are serialized at the database level.

This is fine for moderate workloads but will become a bottleneck for spaces with high write throughput across multiple branches. The spec should acknowledge this limitation and discuss potential mitigations (sharding within a space, separate databases per branch, etc).

### 2.5 blob Table Deduplication Cost

Every JSON value is content-addressed and deduplicated in the blob table. This means every write computes a merkle-reference hash (involving recursive tree construction for nested objects) before insertion. For large JSON values (e.g., 100KB documents), this hash computation is non-trivial.

The `INSERT OR IGNORE` deduplication is efficient at the SQL level, but the hash computation happens in application code before the SQL query. The spec should note that this is a deliberate trade-off of write latency for storage efficiency.

---

## 3. Risks and Concerns

### 3.1 Merge Conflict Granularity is Too Coarse

Entity-level conflict detection (06-branching.md section 6.8.3) means that if two branches each modify a *different field* of the same entity, it's reported as a conflict. For entities with many fields (e.g., a user profile with 50 fields), this creates unnecessary conflicts.

The spec acknowledges this ("Clients that want field-level merge can implement it in their resolution logic") but pushing merge intelligence to the client has problems:

- Every client must re-implement field-level merge
- Client implementations may be inconsistent
- The server has all the information needed for three-way merge

**Recommendation**: Consider a server-side option for field-level auto-merge using JSON Merge Patch (RFC 7396) semantics when both branches modify non-overlapping fields. Entity-level conflict remains the fallback for overlapping modifications.

### 3.2 Soft-Delete of Branches Permanently Consumes Names

Section 6.9.2 says "The branch name is permanently consumed -- a new branch with the same name cannot be created." This is surprising and potentially annoying in practice. Users will naturally want to reuse branch names like "draft" or "staging".

**Recommendation**: Either (a) allow name reuse after deletion (with a generation counter for disambiguation), or (b) explain why permanent consumption is necessary (it's not obvious from the spec).

### 3.3 No Rate Limiting or Quotas

The spec defines no limits on:

- Number of branches per space
- Number of entities per space
- Transaction size (number of operations)
- Blob size limits
- Subscription count per session

These are operational necessities. Even if exact numbers are implementation-specific, the spec should acknowledge that limits exist and define the error types returned when limits are exceeded.

### 3.4 Two blob Tables Are Confusing

The `blob` table stores JSON values (content-addressed). The `blob_store` table stores binary blobs. The naming collision is unfortunate and will cause confusion in code reviews, conversations, and documentation.

**Recommendation**: Rename `blob` to `datum` (its v1 name, which was actually clearer) or `json_store`, and keep `blob_store` for binary data. Alternatively, rename `blob_store` to `binary_store` or `asset_store`.

### 3.5 The Empty Reference Semantics Are Under-Specified

Section 3.2 of 01-data-model.md defines the Empty reference as:

```typescript
const EMPTY = refer({ id: entityId });
```

This means every entity has a *different* Empty reference. But in the SQL schema, `parent` is `NULL` for the first fact of an entity, not the entity-specific Empty reference. The spec and the SQL schema disagree on how genesis is represented.

In 02-storage.md section 3.2: `parent TEXT, -- Hash of previous fact (NULL for first write)`

In 01-data-model.md section 3.2: `parent` equals the Empty reference.

Which is it -- NULL or the computed Empty hash? This affects hash computation (the fact hash includes parent), conflict detection, and client-side causal chain traversal.

---

## 4. Missed Opportunities

### 4.1 Patches Could Enable CRDT-Like Merge

The spec has both patches (fine-grained operations on JSON) and branching (divergent histories that need merging). These two features *almost* combine into automatic merge:

- If both branches apply patches to the same entity, and the patches target non-overlapping paths, they can be automatically composed.
- The `splice` operation on arrays could potentially use CRDT-style position identifiers to enable concurrent array editing.

The spec currently treats patches as dumb replay units. With minimal additional structure (e.g., path-based conflict detection during merge), patches could enable automatic field-level merge without client intervention.

### 4.2 Content-Addressed Blobs Enable Cross-Space Deduplication

The spec scopes blob storage per-space (each space has its own SQLite database). But if two spaces store the same image, it's stored twice. A shared blob store (or blob federation protocol) could deduplicate across spaces.

This is probably out of scope for v2, but the content-addressing foundation makes it possible in the future. Worth noting as a forward-looking architectural property.

### 4.3 Subscription Batching and Coalescing

The spec doesn't discuss batching of subscription updates. If 10 commits happen in quick succession, should the server send 10 separate updates or coalesce them into one? Coalescing would reduce network overhead and client-side processing. The spec should at least mention this as an implementation choice.

### 4.4 Missing "Diff" Query for Branches

The branch model supports comparing two branches (via separate queries), but there's no first-class "diff" operation. A branch diff that returns the set of entities that differ between source and target (with their values on each side) would be extremely useful for merge preview, code review workflows, and conflict resolution UIs.

### 4.5 No Compaction or Vacuum Strategy

SQLite databases grow over time as facts accumulate. The spec should discuss:

- When to run `VACUUM`
- Whether old snapshots can be safely deleted (answered: yes, but no automation discussed)
- Whether a WAL checkpoint strategy is needed beyond SQLite's defaults

---

## 5. Consistency Issues Between Sections

### 5.1 Version Scope Contradiction (Acknowledged)

README open item #3 identifies the contradiction: 03-commit-model.md section 3.7.3 says versions are per-branch; 06-branching.md section 6.4.3 says versions are space-global. The README resolves this in favor of global versions, but the contradictory text in 03-commit-model.md has not been corrected. Section 3.7.3 still shows per-branch versioning.

### 5.2 Selector Structure Contradiction (Acknowledged)

README open item #1 identifies this: 04-protocol.md uses three-level selectors (`entity -> mimeType -> parent`), while 05-queries.md uses two-level selectors (`entity -> match`). The README resolves in favor of the simpler form, but 04-protocol.md still has the old form throughout, including all code examples.

### 5.3 FactSet Structure Contradiction (Acknowledged)

README open item #2: 05-queries.md section 5.7.1 defines FactSet with a `contentType` level that should be removed. The FactSet still has the three-level nesting in the spec text.

### 5.4 ClientCommit vs Transaction Confusion

Section 3.2 defines `Transaction` (with operations, codeCID, branch). Section 3.4 defines `ClientCommit` (with reads, operations, codeCID, branch). These are clearly different types with overlapping fields. But the protocol section (04-protocol.md) uses `TransactCommand` with `args` containing `operations` -- which type is actually sent over the wire?

The relationship between Transaction, ClientCommit, and TransactCommand.args is unclear. It appears that `ClientCommit` is the full structure (with reads), `Transaction` is a simplified view, and `TransactCommand.args` is neither (it lacks the reads field). How does the server validate reads if the TransactCommand doesn't include them?

**Recommendation**: Unify these types. The wire format should be `ClientCommit` (or a type that clearly maps to it). `Transaction` can be removed or redefined as the server-side resolved form.

### 5.5 PatchOperation Name Collision

In 01-data-model.md: `PatchOperation` is a union of `ReplaceOp | AddOp | RemoveOp | MoveOp | SpliceOp`.

In 03-commit-model.md: `PatchOperation` is an interface `{ op: "patch"; id: EntityId; patches: PatchOp[]; parent: Reference; }`.

Same name, completely different types. The first is a single patch op (replace, add, remove). The second is a transaction-level operation that contains patch ops. This will cause confusion in implementation.

**Recommendation**: Rename the transaction-level type to `PatchWriteOperation` or similar.

### 5.6 Branch Data Model Field Mismatch

`06-branching.md` section 6.2 defines `Branch` with a `status: "active" | "deleted"` field. The SQL in `02-storage.md` section 3.6 has no `status` column. The SQL also has `head_version` which is described differently between the two sections (the TypeScript type calls it `headVersion`, the SQL uses `head_version`, and there is ambiguity about whether it tracks per-branch commits or the global Lamport clock value).

### 5.7 head Table Has No Version Column

The `head` table schema (02-storage.md section 3.3) has `(branch, id, fact_hash)` but no `version` column. However, `06-branching.md` section 6.2.1 defines `BranchHead` with a `version: number` field. The SQL representation and TypeScript representation are misaligned.

Without a version column on the head table, determining an entity's current version on a branch requires joining to the fact table (`SELECT f.version FROM fact f WHERE f.hash = h.fact_hash`). This is a performance overhead for every version comparison during commit validation.

**Recommendation**: Add `version INTEGER NOT NULL` to the head table. It's denormalized but eliminates a join during the hottest code path (commit validation).

---

## 6. Alignment with Verifiable Execution Spec

### 6.1 Dropping `the` Dimension Breaks Receipt Structure

The verifiable-execution spec (01-foundations.md section 4.3) explicitly uses the `the` field as a structural dimension for different "views" of an entity:

- `application/json` -- Standard data
- `application/commit+json` -- Commit/audit records
- `application/meta+json` -- Metadata
- `application/acl+json` -- Access control lists
- `application/label+json` -- IFC labels

Memory v2 drops the `the` dimension entirely. This means:

- Commit records can no longer be stored as `{the: "application/commit+json", of: space}` facts
- ACLs can no longer be stored as `{the: "application/acl+json"}` facts
- Label facts can no longer be typed as `{the: "application/label+json"}`

The Memory v2 spec stores blob metadata as a regular entity with a derived ID (`urn:blob-meta:<hash>`), which is the pattern that would replace `the`-based typing. But the verifiable-execution spec's commit model fundamentally relies on the `the` dimension for structural typing of facts.

**Impact**: Either Memory v2 needs to preserve some form of type dimension (even if not called `the`), or the verifiable-execution spec's commit model needs to be reworked to use derived entity IDs instead of type dimensions.

### 6.2 Version-Based Validation vs CAS

The verifiable-execution spec (02-commit-model.md section 5.10.2) describes version-based validation as a "future enhancement" to the current CAS model. Memory v2 jumps straight to version-based validation as the only model. This is a forward leap that should be flagged:

- The verifiable-execution spec's verification model (section 9.5) relies on replaying fact chains via `cause` (hash-based). Version-based validation weakens the causal chain because a commit doesn't need to reference the exact previous state -- it just needs a "fresh enough" version.
- This means the causal chain from the verifiable-execution spec (where every fact's `cause` points to the exact predecessor) is no longer strictly maintained by the validation rule. A fact's `parent` still records the hash of what the client *thought* was the predecessor, but the server doesn't verify that this hash is the actual current head -- it only checks the version.

**Impact**: Verification by replaying the cause chain (as described in verifiable-execution 9.5) may find gaps or inconsistencies if version-based validation allows commits whose `parent` doesn't match the actual head at commit time.

### 6.3 Missing Receipt/Commit Provenance Integration

The verifiable-execution spec describes rich receipts (section 7) with `codeCID`, `inputCommitments`, `inputLabelCommitments`, `cfcPolicyCID`, etc. Memory v2's commit table has only `hash`, `version`, `branch`, `reads`, `created_at`. There is no field for:

- `codeCID` (mentioned in Transaction type but not in the commit SQL table)
- Label commitments
- CFC policy references
- Signatures

The commit table needs additional columns (or a separate receipt table) to support the verification model from the verifiable-execution spec.

### 6.4 ACL Storage Model Diverges

The verifiable-execution spec stores ACLs as facts with `the: "application/acl+json"`. Memory v2 mentions ACL in the protocol section (04-protocol.md section 4.5.3) but doesn't define how ACLs are stored. Since Memory v2 has no `the` dimension, ACLs would presumably be stored as regular entities with a conventional ID prefix (like `urn:acl:<space>`), but this is not specified.

### 6.5 No Label Facts in Memory v2 Storage

The verifiable-execution spec (06-cfc-and-trust.md section 10.3.1) stores IFC labels as `{the: "application/label+json"}` facts. Memory v2 stores blob metadata (including labels) as regular entities, but the mapping from the verifiable-execution spec's label model to Memory v2's entity model is not described.

### 6.6 Audit Trail Weaker Without `the` Dimension

The verifiable-execution spec's audit model relies on being able to query commit facts by type (`application/commit+json`). In Memory v2, commits live in a separate `commit` table, not as entities. This means:

- Commits are not entities, so they can't participate in the entity/fact/patch system
- Commits can't have metadata facts attached to them
- The verifiable-execution spec's model of "everything is a fact" breaks down

The Memory v2 design is arguably simpler (dedicated commit table), but it sacrifices the compositional elegance of the verifiable-execution spec's "facts all the way down" model.

---

## 7. Type Definition Sufficiency

### 7.1 Missing Types

The following types are referenced but never defined:

- `BranchId` (used in Transaction.branch, protocol commands)
- `BranchName` (used in QueryOptions, SubscriptionState)
- `SpaceId` (used in Command.sub, protocol commands)
- `DID` (used in UCAN structures)
- `JSONValue` (used throughout -- should reference a specific definition)
- `JSONSchema` (used in SchemaPathSelector)
- `Signature` and `Authorization` (used in 4.5 but not fully defined)
- `Delegation` (used in Command.prf)
- `Clock` (used in connect options)
- `Signer` (used in connect options)

### 7.2 Type Inconsistencies

- `EntityId` is defined as `` `${string}:${string}` `` -- this is so broad it matches "a:b", "http://x:y", or "::" . The spec examples use `urn:entity:abc123` format but the type doesn't enforce the `urn:entity:` prefix.
- `Reference` is branded with `unique symbol` but serialized as a plain string. The branding only works in TypeScript; at runtime, references are untyped strings.
- `PatchOp` vs `PatchOperation` -- both names are used in different sections for the same concept (the individual patch operations like replace/add/remove).

---

## 8. Summary of Priorities

### Must Fix (blocks correct implementation)

1. Resolve the branch creation contradiction (eager copy vs lazy fallback) between 02-storage and 06-branching
2. Add protocol bindings for branch lifecycle operations
3. Reconcile Transaction/ClientCommit/TransactCommand types
4. Fix the PatchOperation name collision
5. Add version cross-check (hash-to-version verification) in commit validation
6. Address the `the` dimension removal impact on verifiable-execution alignment

### Should Fix (correctness or performance concern)

7. Add `version` column to head table
8. Add `branch` column to fact table (or document the performance trade-off)
9. Resolve the remaining acknowledged open items in the spec text (not just in README)
10. Define garbage collection / fact compaction strategy
11. Define branch depth limits or materialization strategy
12. Define rate limits and error types for resource exhaustion

### Nice to Have (quality improvements)

13. Rename the `blob` table to avoid collision with `blob_store`
14. Consider field-level merge support
15. Add branch diff operation
16. Define subscription coalescing behavior
17. Document the `codeCID` column (or lack thereof) in the commit table
