# Review: Requirements Coverage Audit

**Reviewer**: Reviewer 1 (Requirements Coverage)
**Date**: 2026-02-07
**Scope**: All spec files (README.md, 01 through 06) evaluated against CONTEXT.md requirements

---

## Summary

The spec covers the majority of requirements with substantial depth. The strongest
areas are the commit model, storage layer, and branching. The weakest areas are
the protocol section (which carries over v1 artifacts that contradict the "boring
nomenclature" goal) and the schema traversal section (which describes the
algorithm well but lacks the concrete implementation details needed to reimplement
from scratch). Four requirements receive FULL marks, three are PARTIAL, and two
are PARTIAL due to internal inconsistencies that the README's Open Items section
already acknowledges.

**Overall grade: SOLID PARTIAL** -- the spec is close to complete but has
identifiable gaps that would block a clean reimplementation.

---

## Requirement-by-Requirement Assessment

### R1. Detailed spec for memory component including client code and protocol, good enough to reimplement from scratch

**Grade: PARTIAL**

**What's covered:**
- Data model (01): Thorough. Entities, facts, references, blobs, metadata,
  patches, snapshots, and the type system are all defined with TypeScript types
  and prose explanations.
- Storage (02): Thorough. Full SQLite schema with CREATE TABLE, indices, write
  path, read path, snapshot creation, branch storage, PIT reads, blob store ops.
  This section is the strongest -- you could implement the database layer from
  this alone.
- Commit model (03): Thorough. Operations, transactions, confirmed/pending
  state, validation algorithm, conflict handling, commit chain, atomicity,
  retry strategy.
- Protocol (04): Adequate but has issues (see below). Commands, message
  format, auth model, client API, blob transfer.
- Queries (05): Adequate for simple queries, weaker for schema traversal (see
  R9 below).
- Branching (06): Thorough. Lifecycle, isolation, merge algorithm, conflict
  resolution, PIT reads on branches.

**Gaps that would block reimplementation:**
1. **No formal error codes or error catalog.** Error types are defined in 04
   but there is no enumeration of all possible error conditions across the
   system. An implementer would need to guess which errors to return in edge
   cases (e.g., transacting on a deleted branch, merging a branch into itself,
   querying a non-existent branch).
2. **Client library internals are under-specified.** Section 04.8 shows the
   public API but says nothing about how the client manages the pending queue,
   how it resolves provisional hashes, or how it handles reconnection. The
   confirmed/pending state model is well-described in 03, but the client
   implementation that maintains it is not.
3. **Hash computation algorithm is referenced but not specified.** Section 01
   says hashes use "SHA-256 over a canonical merkle-tree encoding" and
   references "the same `merkle-reference` algorithm used in v1." An
   implementer without access to the v1 codebase cannot reimplement this. The
   canonical encoding (how objects are ordered, how arrays are handled, what
   serialization is used before hashing) is critical for interoperability and
   is not described.
4. **UCAN specifics are thin.** The auth section (04.5) describes UCAN at a
   high level but does not specify the UCAN version, the capability
   attenuation rules, or the delegation chain validation algorithm. An
   implementer would need to consult external UCAN specs.

---

### R2. No backward compatibility needed (database, protocol, client)

**Grade: FULL**

- 02.10 explicitly states "clean break from v1. There is no migration path."
- README.md goal 1 says "No backward compatibility."
- 03.12 provides a mapping table from v1 to v2 concepts for reference, but
  this is informational, not a compatibility layer.
- 04.12 provides a similar mapping for the protocol.

No backward compatibility concerns leak into the design. The only caveat is
that some v1 artifacts remain in 04 (the Selector structure), but these are
called out in the Open Items and are not framed as compatibility measures.

---

### R3. Drop "the" (always application/json), rename "of" to id, "since" to version, use boring terms

**Grade: PARTIAL**

**What's covered:**
- README.md contains a complete nomenclature mapping table.
- 01.8 explicitly states "there is no MIME-type or `the` dimension" and
  explains the rationale.
- All of 01, 02, 03, and 06 consistently use the new terms (`id`, `version`,
  `parent`, `value`, `Empty`, `Write`, `Delete`).

**Gaps:**
- **04-protocol.md Section 4.4 (Selectors)** still uses a three-level nesting
  with MIME types: `entityId -> mimeType -> parent`. This directly contradicts
  the "dropped the" requirement. The README acknowledges this in Open Item 1,
  but the spec text itself has not been corrected.
- **04-protocol.md Section 4.3.5 (graph.query)** also uses a SchemaSelector
  with a `mimeType` level in its nesting.
- **05-queries.md Section 5.7.1 (FactSet)** defines FactSet with a
  `contentType` level: `entityId -> contentType -> parentHash -> FactEntry`.
  This also contradicts the design. Acknowledged in Open Item 2.
- **04-protocol.md Section 4.6.2** references `lastRevision` keyed by
  `"entityId/mimeType"`, which again references a type dimension that should
  not exist.

The inconsistency is acknowledged but unresolved. For a spec meant to be
implemented, this is a problem -- an implementer would need to decide which
version is authoritative for these structures.

---

### R4. Implement the future commit model from verifiable-execution/02-commit-model.md (nursery/heap to confirmed/pending, version-based validation)

**Grade: FULL**

**What's covered:**
- 03.3 defines the two-tier client state model (Confirmed / Pending) with
  clear descriptions, diagrams, and the reading-across-tiers algorithm.
- 03.4 defines the ClientCommit structure with explicit `reads.confirmed` and
  `reads.pending` arrays, matching section 5.10.1 of the verifiable-execution
  spec.
- 03.5 defines stacked pending commits with cascading rejection, matching
  section 5.10.3.
- 03.6 defines the version-based validation rule
  (`read.version >= server.head.version`), matching section 5.10.2.
- 03.7 defines CommitLogEntry with `original` and `resolution` fields
  (including `commitResolutions` and `hashMappings`), matching section 5.10.3.

**Observation:** The spec goes further than the verifiable-execution source
material in some areas (retry strategy in 03.11, branch-aware commits in 03.10)
which is appropriate. The mapping from the old CAS model to the new model is
clear in 03.12.

**One minor gap:** The verifiable-execution spec's section 5.11 discusses
document-to-commit provenance (using `since` to find the producing commit)
and path-level activity tracking for the scheduler. The Memory v2 spec does
not explicitly address path-level activity tracking or scheduler integration.
This may be intentional (out of scope for Memory v2) but is worth noting since
CONTEXT.md references "the future commit model" broadly.

---

### R5. Transactions support incremental changes (patches) vs whole document replacement, store increments, replay on retrieval, snapshots

**Grade: FULL**

**What's covered:**
- 01.2.1 defines SetWrite and PatchWrite fact types.
- 01.6 defines all patch operations (replace, add, remove, move, splice) with
  TypeScript types.
- 01.6.3 defines patch application semantics (in-order, fail-entire-on-error).
- 01.7 defines snapshots (structure, creation policy, read path, invariants).
- 02.4 details how patches are stored in the database (serialized JSON ops in
  the blob table, fact_type='patch').
- 02.5 details the read path including snapshot lookup, patch collection, and
  replay.
- 02.6 details snapshot creation triggers and materialization.
- 03.1 defines PatchOperation in the commit model.

This is one of the most thoroughly specified requirements. The read path
algorithm is given in both SQL and TypeScript. The snapshot policy is
configurable. Edge cases (no snapshot available, delete during replay) are
addressed.

---

### R6. Content-addressed never-changing data (blobs) with mutable metadata (IFC labels)

**Grade: FULL**

**What's covered:**
- 01.4 defines the Blob interface (hash, data, contentType, size) with clear
  semantics (immutable, deduplicated, no history).
- 01.4.1 defines the convention for referencing blobs from entities (`$blob`
  field).
- 01.5 defines BlobMetadata as a regular entity, with a derivation function
  for the metadata entity ID (`urn:blob-meta:<hash>`).
- 02.3.7 defines the `blob_store` table (separate from `blob` which stores
  JSON values).
- 02.9 defines blob store read/write SQL operations.
- 04.9 defines HTTP endpoints for blob upload/download (PUT/GET /blob/<hash>).
- 05.6 covers classification and redaction using IFC labels from blob metadata.

The separation between immutable blob data and mutable metadata (stored as a
regular entity) is clean and well-motivated.

---

### R7. Point-in-time retrieval

**Grade: FULL (with minor note)**

**What's covered:**
- 01.7.2 describes the read path with snapshots for PIT reads.
- 02.5.2 provides the SQL queries for PIT reads.
- 02.8 provides the full PIT read algorithm in TypeScript, including
  branch-aware PIT reads with SQL (02.8.2).
- 05.5 defines PIT queries with the reconstruction algorithm.
- 05.5.3 describes PIT with schema queries (consistent graph snapshot).
- 05.9.3 describes branch + PIT interaction.
- 06.10 describes PIT reads on branches with version bounds.

**Minor note:** The spec does not address the cost of PIT reads at very old
versions where no snapshot exists (full replay from genesis). An implementer
might want guidance on whether to create retroactive snapshots or cap the
replay depth. This is an operational concern, not a spec gap.

---

### R8. Branching support

**Grade: FULL**

**What's covered:**
- 06.1-06.2: Default branch, branch data model, head table, storage.
- 06.3: Branch creation (API, semantics, fork-from-fork).
- 06.4: Writing to branches (commit targeting, validation, version assignment).
- 06.5: Reading from branches (head resolution with parent fallback).
- 06.6: Branch isolation (fundamental guarantee, shared history).
- 06.7: Merging (API, algorithm, fast-forward, merge commit).
- 06.8: Conflict resolution (structure, protocol, inline resolutions,
  granularity discussion).
- 06.9: Branch deletion (soft delete, semantics).
- 06.10: PIT reads on branches.
- 06.11: Branch listing API.
- 06.12: Use cases (feature branches, undo/redo, speculative execution,
  collaborative editing).
- 02.7: Storage-level branch representation (SQL for create, writes, version
  numbering, deletion).

This is extremely thorough. The merge algorithm, conflict resolution protocol,
and head resolution with parent chain fallback are all implementable from the
spec.

**One gap:** The README Open Item 4 notes that branch lifecycle protocol
bindings (commands for create/merge/delete/list) are missing from
04-protocol.md. The branching spec (06) defines the APIs but 04 does not
include the corresponding wire protocol commands. An implementer would need to
infer the command format.

---

### R9. Reuse traverse.ts code for schema-based queries and subscriptions

**Grade: PARTIAL**

**What's covered:**
- 05.3 describes schema queries with explicit references to traverse.ts
  patterns (getAtPath, SchemaObjectTraverser.traverseWithSchema,
  followPointer).
- 05.3.2 provides the traversal algorithm in pseudocode (path following,
  schema-guided filtering, reference resolution).
- 05.3.3 defines cycle detection with CycleTracker and CompoundCycleTracker.
- 05.3.4 defines schema narrowing with combineSchema.
- 05.3.5 defines SchemaTracker for subscription bookkeeping.
- 05.4.3 describes schema-aware subscriptions with link re-evaluation.

**Gaps:**
1. **Reference format is not specified.** Section 05.3.2 says "when the
   traverser encounters a reference (a value that points to another entity)"
   but does not define what a reference looks like in the v2 data model. In v1
   it was `{ "/": "bafk..." }` or `{ the, of, ... }`. In 04.9.3 there is an
   example with `{ "/": "baedrei...blobhash" }` for blob refs. But for entity
   references that the schema traverser would follow, the format is never
   explicitly defined. This is a critical gap -- the traverser needs to know
   how to detect and parse references.

2. **SchemaSelector still has MIME type level.** The SchemaSelector in 05.3.1
   uses `Record<EntityId | "*", Record<string, SchemaPathSelector>>` where the
   inner key is described as a content type. This contradicts the "dropped the"
   design. In 04.3.5, it's even more explicit with three levels. This
   inconsistency makes the shape of a schema query ambiguous.

3. **evaluateDocumentLinks is referenced but not specified.** Section 05.4.3
   says the server uses `evaluateDocumentLinks` from `space-schema.ts` to
   re-evaluate links when entities change, but the algorithm is not described
   in the spec. An implementer without access to the v1 code could not
   implement this.

4. **Schema storage/lookup is not detailed.** Section 01.8.2 says schemas are
   stored as regular entities, and 01.8.3 says the binding is "by convention
   or by a schema registry." The spec does not define the registry entity
   format, how the traverser discovers which schema applies to a given entity,
   or how schema changes propagate to active subscriptions.

---

## Assessment of Open Items in README.md

### Open Item 1: Selector structure (three-level vs two-level)

**Valid.** This is a real inconsistency. Section 04.4 uses `entityId -> mimeType
-> parent` which contradicts the "dropped the" design. Section 05.2 uses the
simpler form. The recommendation to resolve in favor of the simpler form is
correct.

### Open Item 2: FactSet structure (contentType level)

**Valid.** Section 05.7.1 has a `contentType` level that should not exist.
The recommended fix (`{ [entityId]: { value, version, parent } }`) is correct.

### Open Item 3: Version scope (per-branch vs global)

**Valid.** Section 03.7.3 says versions are per-branch (with independent
sequences per branch). Section 06.4.3 says they are globally shared. The
global version is correct -- per-branch versions would break cross-branch
PIT queries and the total ordering guarantee. The contradiction in 03.7.3 is
clear: the example shows `Branch "main": version 1, 2, 3, 4, ...` and
`Branch "draft": version 1, 2, 3, ...` as independent sequences, which
directly contradicts 06.4.3's global version model.

### Open Item 4: Branch lifecycle protocol bindings

**Valid.** Section 06 defines branch APIs but 04 has no corresponding commands.
The suggested commands (`/memory/branch/create`, etc.) are reasonable. This is a
genuine gap -- without these, the protocol spec is incomplete for branching.

### Additional Open Items Not Listed

1. **Reference format for entity links.** As noted in R9, the format for
   entity-to-entity references (as opposed to blob references) is never
   defined. This is needed for schema traversal to work.

2. **Hash algorithm specification.** The merkle-reference algorithm is
   referenced by name but not specified. This is needed for interoperability.

3. **TransactCommand does not include reads.** Section 04.3.1 defines
   `TransactCommand.args` as `{ operations, codeCID?, branch? }` but does not
   include the `reads` field that the ClientCommit (03.4) requires. Either the
   TransactCommand should include the reads, or the protocol needs to explain
   how reads are conveyed.

4. **Commit response structure.** Section 04.3.1 says the success response is
   `{ ok: Commit }` but does not define the `Commit` type in the response
   context. Is it the same as `CommitLogEntry` from 03.7.2? Does it include
   the `resolution` field? The client needs this to update its confirmed state.

5. **`head_version` in the branch table vs global version.** Section 02.3.6
   defines `head_version` in the branch table, and 02.7.3 shows it being
   incremented (`head_version + 1`). But if versions are globally assigned
   (as they should be per Open Item 3), then `head_version` should be set to
   the global version, not incremented by 1 from its current value. This is
   another manifestation of the per-branch vs global version inconsistency.

---

## Reimplementation Readiness Summary

| Area | Reimplementable? | Notes |
|------|-----------------|-------|
| Data model | Yes | Clear types, well-defined |
| Storage/SQLite | Yes | Full schema, queries, algorithms |
| Commit model | Yes | Thorough, well-structured |
| Protocol (transport) | Mostly | Missing branch commands, reads in transact |
| Protocol (auth) | No | UCAN under-specified for standalone impl |
| Protocol (client API) | Surface only | Internals (pending mgmt) not specified |
| Queries (simple) | Yes | Clear |
| Queries (schema) | Partially | Reference format missing, evaluateDocumentLinks unspecified |
| Subscriptions | Mostly | Simple subs yes, schema subs partially |
| Branching | Yes | Thorough |
| Hash algorithm | No | Referenced but not specified |

---

## Recommendations

1. **Resolve the 4 Open Items in-spec** rather than leaving them as errata.
   The contradictions in selector structure, FactSet, and version scope are
   confusing enough to cause implementation errors.

2. **Define the entity reference format** explicitly. This is blocking for
   schema traversal.

3. **Specify the hash algorithm** or at minimum point to a concrete external
   reference (the `merkle-reference` package, a test vector set, etc.).

4. **Add reads to TransactCommand** or clarify how the ClientCommit's read
   dependencies are conveyed over the protocol.

5. **Define the Commit response type** so the client knows exactly what it
   receives after a successful transact.

6. **Add branch lifecycle commands to 04-protocol.md** (create, merge, delete,
   list) with full command/response types.
