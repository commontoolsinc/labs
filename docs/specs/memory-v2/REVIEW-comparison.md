# Review: Codebase Comparison (Memory v1 Implementation vs. v2 Spec)

**Reviewer:** Reviewer 3 (Codebase Comparison)
**Scope:** Delta analysis between the existing v1 implementation and the proposed
v2 specification. Covers what is lost, what is gained, what has changed, migration
concerns, and the accuracy of the v2 spec's claim to reuse `traverse.ts` patterns.

**Files examined:**

- v2 spec: `README.md`, `CONTEXT.md`, `01-data-model.md`, `02-storage.md`,
  `03-commit-model.md`, `04-protocol.md`, `05-queries.md`, `06-branching.md`
- v1 implementation: `packages/memory/interface.ts`, `space.ts`, `commit.ts`,
  `consumer.ts`, `provider.ts`, `subscription.ts`, `space-schema.ts`, `acl.ts`,
  `receipt.ts`
- Traversal: `packages/runner/src/traverse.ts` (2342 lines)

---

## 1. What Is Lost

These are concrete behaviors, types, and capabilities present in the v1
implementation that are absent from or under-specified in the v2 spec.

### 1.1 The `the` Dimension (MIME Type per Fact)

The v1 system uses `the` (MIME type) as a first-class dimension throughout:

- The `fact` table has a `the TEXT NOT NULL` column.
- The `memory` table uses `PRIMARY KEY (the, of)` -- the same entity can have
  different facts for different MIME types.
- The `Selector` type is three-level: `Record<Of, Record<The, Record<Cause, ...>>>`.
- The `Changes` type uses the `OfTheCause<T>` nesting pattern with `the` as
  the second level.
- Labels use `LABEL_TYPE = "application/label+json"`.
- Commits use `COMMIT_LOG_TYPE = "application/commit+json"`.

The v2 spec drops `the` entirely. However:

- The v2 `04-protocol.md` still defines `SchemaSelector` as three-level
  (`Record<EntityId, Record<string, SchemaPathSelector>>`), with the middle
  level described as "content type." The README acknowledges this as Open Item 1.
- The v2 `05-queries.md` uses a simplified two-level form. This inconsistency
  must be resolved before implementation.

**Risk:** The v1 system relies on `the` for system-level internal entities like
labels (`application/label+json`) and commits (`application/commit+json`). The
v2 spec needs to clarify how these system entities are distinguished without
the MIME type dimension.

### 1.2 The `state` View

V1 defines a `state` SQL view that joins `memory -> fact -> datum`, providing a
single query surface for the current materialized state:

```sql
CREATE VIEW IF NOT EXISTS state AS
SELECT memory.the, memory.of, datum.source AS 'is',
       fact.cause, memory.fact, datum.this AS proof, fact.since
FROM memory
JOIN fact ON memory.fact = fact.this
JOIN datum ON datum.this = fact.'is';
```

V2's schema has no equivalent. The read path in `02-storage.md` describes
explicit multi-step SQL (head -> fact -> blob join), but there is no unified
view. This is a minor structural loss but may impact the ergonomics of
debugging and ad-hoc SQL queries against the database.

### 1.3 The `Invariant` Fact Type

V1 defines three fact kinds:

1. `Assertion` -- sets a value
2. `Retraction` -- tombstone
3. `Invariant` -- identity assertion (cause == hash of the invariant itself)

V2 has `SetWrite`, `PatchWrite`, and `Delete`. There is no `Invariant`
equivalent. The `Invariant` type in v1 is used as a "this value was already
here" marker. If this was used for anything meaningful, the behavior must be
replicated.

### 1.4 The `Unclaimed` Reference Computation

V1 computes a deterministic genesis reference from `{the, of}`:

```typescript
// fact.ts
export function unclaimedRef(the: string, of: string): Reference {
  return refer({ the, of });
}
```

V2 computes the `Empty` reference from `{id}` only (since `the` is dropped).
This is a deliberate simplification, but means the genesis reference format
is incompatible between v1 and v2.

### 1.5 TransformStream Architecture

V1's consumer and provider are both `TransformStream` subclasses:

- `ConsumerSession extends TransformStream<ProviderCommand, UCAN<ConsumerCommand>>`
- `ProviderSession extends TransformStream<UCAN<ConsumerCommand>, ProviderCommand>`

These are piped together bidirectionally. The consumer has a send queue with
`Promise.withResolvers()` for ordered message delivery and response correlation.
The `ConsumerInvocation` class provides typed request/response semantics over
this stream.

V2 specifies WebSocket and HTTP transports but does not describe the streaming
abstraction or the send queue pattern. The spec leaves the client library API
at a high level (`connect() -> session`, `session.transact()`, etc.) without
the intermediate message correlation layer.

**Risk:** The TransformStream pattern is deeply embedded in the consumer/provider
architecture. The runtime (runner) creates and pipes these streams. Any
migration must replace this plumbing, not just the protocol messages.

### 1.6 `Brief` and Subscription Briefing

V1 defines a `Brief` type for subscription state summaries:

```typescript
type Brief<Space> = {
  sub: Space;
  args: { selector: Selector; selection: Selection };
  meta?: Meta;
};
```

This is used by `SubscriptionCommand` alongside `transact`. V2's subscription
model in `05-queries.md` describes initial delivery and incremental updates but
does not mention briefing or state summaries.

### 1.7 `cause` Chain Query (Recursive CTE)

V1 implements a recursive CTE to walk the full causal history of an entity:

```sql
WITH RECURSIVE cause_of(c, f) AS (
    SELECT cause, this FROM fact WHERE fact.of = :of AND fact.the = :the
    UNION
    SELECT cause, this FROM fact, cause_of WHERE fact.this = cause_of.c
)
SELECT c as cause, f as fact FROM cause_of
```

V2 does not define any equivalent history traversal query. The `fact` table
stores `parent` references, but no spec section describes walking the chain.
Point-in-time queries reconstruct state at a version, but they don't expose
the causal chain itself.

### 1.8 Commit as Entity Assertion

V1 stores commits as regular fact assertions on the space DID itself:

```typescript
const COMMIT_LOG_TYPE = "application/commit+json";
// Creates an assertion: { the: COMMIT_LOG_TYPE, of: spaceDID, is: commitData }
```

This means commit history is queryable through the same query mechanisms as
regular entities. V2 has a dedicated `commit` table with a different structure.
This is arguably an improvement, but it means commit history is no longer
accessible through the standard entity query path.

### 1.9 Prepared Statement Caching

V1 implements a `WeakMap<Database, PreparedStatements>` cache for all SQL
statements (export, causeChain, getFact, getLabelsBatch, importDatum,
importFact, importMemory, swap). V2's storage spec describes SQL queries
inline but says nothing about statement preparation or caching.

### 1.10 Label Batch Query

V1 has a specialized batch label query using `json_each()`:

```sql
SELECT ... FROM state
WHERE state.the = :the AND state.of IN (SELECT value FROM json_each(:ofs))
```

V2 mentions labels/classification but does not describe batch-optimized label
retrieval.

### 1.11 Subscription Pattern Matching

V1's `subscription.ts` implements a pattern-matching system for determining
which subscriptions are affected by a commit:

- `match()` checks a transaction against `watch://` addresses.
- `channels()` and `fromSelector()` extract watch patterns from selectors.
- `formatAddress()` creates `watch:///the/of` URIs.

V2 describes subscription notification at a high level ("server sends updates
when entities change") but does not describe the pattern-matching machinery.

### 1.12 Incremental Schema Subscription Updates

V1's `provider.ts` has `processIncrementalUpdate()` which uses
`evaluateDocumentLinks()` from `space-schema.ts` to determine whether a commit
affects a schema subscription without re-running the full traversal. This is a
significant optimization for live subscriptions.

V2's spec says the server "re-evaluates the query and sends deltas" but does
not describe how to efficiently determine if a commit is relevant to a schema
subscription.

---

## 2. What Is Gained

Features present in the v2 spec that do not exist in v1.

### 2.1 Patch Operations (JSON Patch + Splice)

V2 introduces `PatchWrite` facts with JSON Patch (RFC 6902) operations plus
a `splice` extension for efficient array manipulation. V1 only supports
whole-document replacement via `set` operations. This is a major efficiency
gain for large documents with small changes.

### 2.2 Snapshots

V2 defines periodic materialized snapshots of entity state (section 1.6 of
`01-data-model.md`). Snapshots avoid replaying the full patch chain on every
read. The snapshot creation policy is version-gap and time-based. V1 has no
equivalent -- every read hits the current `state` view which is always a
single fact lookup.

### 2.3 Branching

V2 adds a complete branching system (section 6): O(1) branch creation via
shared fact history, branch-scoped head tables, merging with entity-level
conflict detection, branch deletion (soft-delete). V1 has no branching
concept -- all writes go to a single timeline.

### 2.4 Content-Addressed Binary Blobs

V2 adds a `blob_store` table for immutable, content-addressed binary data and
a `blob_metadata` entity type for mutable metadata (IFC labels). V1 only
stores JSON values in the `datum` table.

### 2.5 Point-in-Time Reads

V2 supports `atVersion` queries that reconstruct entity state at any historical
version using a reconstruction algorithm (find the head at that version, then
resolve the value). V1 has `since` filtering on the `state` view but no true
point-in-time reconstruction.

### 2.6 Dedicated Commit Table

V2 stores commits in a dedicated `commit` table with structured fields
(`version`, `operations` as JSON, `reads` as JSON, `branch`, `timestamp`).
V1 stores commits as regular entity assertions with `application/commit+json`
type. The dedicated table enables more efficient commit history queries and
validation.

### 2.7 Pagination

V2 defines cursor-based pagination for query results (`cursor`, `limit`
parameters, `PageInfo` response). V1 has no pagination support.

### 2.8 `claim` Operation

V2 introduces a `claim` operation that claims an empty entity without writing
a value. V1 achieves something similar through the `Unclaimed -> Assertion`
transition, but it is not a separate operation type.

### 2.9 Two-Tier Read Tracking

V2's `ClientCommit` tracks reads from two sources (`confirmed` and `pending`)
which enables stacked optimistic commits. V1's CAS model tracks a single
`cause` per entity.

---

## 3. What Has Changed

Same concept, different design.

### 3.1 Nomenclature

| v1 | v2 | Notes |
|---|---|---|
| `the` | *(dropped)* | MIME type dimension removed |
| `of` | `id` | Entity identifier |
| `is` | `value` | Entity value |
| `cause` | `parent` | Previous fact reference |
| `since` | `version` | Lamport clock |
| `Assertion` | `Write` (`set`/`patch`) | Broader concept |
| `Retraction` | `Delete` | Direct rename |
| `Unclaimed` | `Empty` | Genesis state |
| `Changes` | `Operation[]` | Flat list vs. nested tree |
| `Selection` | `FactSet` | Query result |
| `datum` table | `blob` table | Content storage |
| `memory` table | `head` table | Current-state pointer |
| Heap | Confirmed | Server-acknowledged |
| Nursery | Pending | Optimistic |

### 3.2 Validation Model: CAS to Version-Based

**V1 (CAS):** The `swap()` function requires an exact `cause` match:

```sql
UPDATE memory SET fact = :fact
WHERE the = :the AND of = :of AND fact = :cause;
```

If the `cause` (hash of the previous fact) does not match the current head,
the update silently fails (0 rows changed) and is treated as a conflict.

**V2 (Version-based):** The validation rule is:

```
For each entity read: read.version >= server.head[entity].version
```

This is a relaxation -- a commit succeeds if the client's read was at least
as recent as the current head, rather than requiring an exact hash match.
This enables the stacked pending commit model where multiple optimistic
commits can coexist without knowing each other's hashes.

### 3.3 Changes Structure: Nested to Flat

**V1:** `Changes` is a deeply nested `OfTheCause<T>` tree:
`Record<Of, Record<The, Record<Cause, ...>>>`. Commits are iterated with
`toChanges()` which yields `{the, of, is, cause}` tuples.

**V2:** `Operation[]` is a flat array of discriminated unions:
`{ op: "set", id, value, parent }`. This is simpler to construct, validate,
and serialize.

### 3.4 Reference Format

**V1:** References are content-addressed hashes of `{the, of, is, cause}`.
The `refer()` function hashes the full fact tuple.

**V2:** References are SHA-256 hashes of the fact content, base32-lower encoded.
The exact input to the hash is `{type, id, value|ops, parent}` (no `the`).

### 3.5 Session Model

**V1:** `Session` is an interface with `transact()`, `query()`, `subscribe()`,
`unsubscribe()`, and `graph.query()` methods. The session is backed by
`ConsumerSession` (a TransformStream) on the client and `ProviderSession`
on the server.

**V2:** The session API surface is similar but simplified. `connect()` returns
a session with `transact()`, `query()`, `subscribe()`, `unsubscribe()`.
Graph queries are a separate `graph.query()` command. The transport layer is
WebSocket/HTTP rather than piped TransformStreams.

### 3.6 ACL Model

**V1:** ACLs are stored as entities with type `application/json` and entity id
`acl:{did}`. Capabilities are hierarchical (READ < WRITE < OWNER). The
`commandRequirement()` function maps protocol commands to required capability
levels.

**V2:** The spec mentions UCAN-based authentication but does not fully specify
the ACL storage or evaluation model. Section 4.5 of `04-protocol.md` describes
UCAN invocation format and mentions capability delegation, but the mapping
from protocol commands to required capabilities is not defined.

### 3.7 Datum/Blob Storage

**V1:** The `datum` table stores JSON values content-addressed. The `this`
column is the merkle reference, `source` is the JSON.

**V2:** The `blob` table stores JSON values content-addressed. The `hash`
column is the reference, `data` is the JSON. Functionally equivalent but
with different column names. V2 adds a separate `blob_store` table for
binary data.

---

## 4. Migration Concerns

### 4.1 Runtime Integration Points

The runner package (`packages/runner/`) creates `ConsumerSession` instances
and pipes them to `ProviderSession` instances via TransformStream. A v2
migration must:

1. Replace `ConsumerSession` / `ProviderSession` with WebSocket/HTTP clients.
2. Remove all `TransformStream` piping logic.
3. Replace the `ConsumerInvocation` request/response correlation pattern.
4. Update the runner's memory integration to use v2 session API.

### 4.2 Changes -> Operations Conversion

Every piece of code that constructs or consumes `Changes` objects must be
rewritten. The v1 `Changes` type uses deeply nested `OfTheCause<T>` records;
v2 uses flat `Operation[]`. This affects:

- `commit.ts`: `create()`, `toRevision()`, `toChanges()`
- `space.ts`: `commit()`, `transact()`
- `consumer.ts`: all invocation handling
- `provider.ts`: subscription notification with `processIncrementalUpdate()`

### 4.3 Selector Three-Level to Two-Level

V1 selectors use `Record<Of, Record<The, Record<Cause, ...>>>`. V2 should
simplify to `Record<EntityId, EntityMatch>`. All subscription pattern matching,
query construction, and `fromSelector()` logic must be updated.

### 4.4 Schema Tracker Key Format

V1's `SchemaTracker` (a `MapSet<string, SchemaPathSelector>`) uses keys
formatted as `${space}/${id}/${type}` (via `getTrackerKey()` in traverse.ts).
V2 drops the `type` dimension, so keys should become `${space}/${id}`. All
schema tracker key construction and lookup code must be updated.

### 4.5 Database Migration

The v1 schema (`datum`, `fact`, `memory` tables with `the` columns) is
incompatible with v2 (`blob`, `fact`, `head`, `commit`, `snapshot`, `branch`
tables without `the`). A full data migration would require:

1. Reading all facts from v1 `state` view.
2. Re-hashing without `the` dimension to compute v2 references.
3. Inserting into v2 tables.
4. Reconstructing version history.

Given the "clean break" design goal, an in-place migration is unlikely.
More likely: v2 spaces start fresh and v1 data is imported as initial state.

### 4.6 Label/Classification System

V1 stores labels as entities with `the = "application/label+json"`. Without
the `the` dimension in v2, labels need a different identification mechanism.
The v2 spec mentions IFC labels on blobs but does not describe how entity-level
classification labels are stored or queried.

### 4.7 Receipt Serialization

V1's `receipt.ts` provides JSON serialization for protocol receipts. V2's
UCAN-based protocol has a different message format. All receipt
serialization/deserialization code must be replaced.

---

## 5. Traverse.ts Reuse Accuracy

The v2 spec (section 5.3 of `05-queries.md`) claims to "reuse the traversal
architecture from `packages/runner/src/traverse.ts`, adapting its patterns
for the Memory v2 data model." This claim is partially accurate but omits
significant complexity.

### 5.1 What the Spec Captures Correctly

The spec accurately describes these `traverse.ts` patterns:

1. **CycleTracker and CompoundCycleTracker** -- the spec's type signatures
   (`CycleTracker<K>`, `CompoundCycleTracker<IdentityKey, SchemaKey, Value>`)
   match the implementation. The `Disposable` pattern and the distinction
   between identity-equality and deep-equality are correctly described.

2. **PointerCycleTracker parameterization** -- the spec correctly identifies
   `CompoundCycleTracker<JSONValue, JSONSchema, any>` as the concrete type.

3. **SchemaTracker (MapSet)** -- the spec describes `MapSet<string,
   SchemaPathSelector>` for tracking which entities have been visited with
   which schemas. This matches the implementation.

4. **combineSchema** -- the spec's pseudocode captures the main cases
   (true schema passthrough, object property intersection). The actual
   implementation also handles `$defs` merging, `asCell`/`asStream` flag
   preservation, and the `ContextualFlowControl.isTrueSchema()` check, which
   are not in the pseudocode.

5. **narrowSchema** -- mentioned but not given pseudocode. The concept of
   re-rooting a selector path when following a link is correct.

6. **traverseWithSchema pseudocode** -- the top-level algorithm (switch on
   schema type, handle anyOf/allOf, recurse into objects/arrays) is correct
   in structure. The `mergeAnyOfMatches` behavior (union of object properties
   across anyOf branches) is mentioned.

### 5.2 What the Spec Omits

The following concrete behaviors from `traverse.ts` are absent from the spec.
These are not minor details -- they are fundamental to how traversal works in
practice.

#### 5.2.1 Link Resolution System

The spec says "when the traverser encounters a reference (a value that points
to another entity), it parses the reference." But it does not describe what
a reference looks like or how it is parsed. In `traverse.ts`:

- `isPrimitiveCellLink(value)` checks if a value is a cell link (an object
  with a specific shape, typically `{ "/": "shortId", ... }`).
- `parseLink(value, address)` extracts `{ space, id, type, path, schema }`
  from a link object, filling in defaults from the address context.
- `NormalizedFullLink` is the structured type for a fully resolved link.
- `isWriteRedirectLink(value)` detects write-redirect links that must be
  followed before the actual value is reached.

The v2 spec needs to define the reference format. The v1 link format is deeply
embedded in the data -- existing cell values contain these link objects. A v2
traverser must either preserve the v1 link format or define a migration path.

#### 5.2.2 Write-Redirect Links

`traverse.ts` has extensive handling for "write redirects" -- links that
redirect to another location before reaching the actual value. The
`getDocAtPath()` function is called with `"writeRedirect"` mode to follow
these chains:

```typescript
const [redirDoc, redirSelector] = this.getDocAtPath(
  docItem, [], DefaultSelector, "writeRedirect"
);
const [linkDoc, _selector] = this.nextLink(redirDoc, redirSelector);
```

This is used in both array element traversal and object property traversal.
The v2 spec does not mention write redirects at all.

#### 5.2.3 `asCell` / `asStream` Schema Flags

`traverse.ts` has a static `asCellOrStream()` method and `mergeSchemaFlags()`
function that handle custom schema extensions:

```typescript
static asCellOrStream(schema: JSONSchema | undefined): boolean {
  return isObject(schema) && (schema.asCell === true || schema.asStream === true);
}
```

When `asCell` or `asStream` is true in a schema, the traverser creates a cell
boundary instead of inlining the value. This is critical for reactivity -- it
determines what granularity of data the client subscribes to.

The v2 spec does not mention `asCell` or `asStream`. If schema-driven
reactivity boundaries are desired in v2, this mechanism needs to be specified.

#### 5.2.4 `IObjectCreator` Extensibility

`traverse.ts` defines an `IObjectCreator<T>` interface with four methods:
`mergeMatches()`, `addOptionalProperty()`, `applyDefault()`, `createObject()`.

Two implementations exist:

1. `StandardObjectCreator` -- used for server-side query traversal. Includes
   optional properties, returns raw JSON.
2. An external implementation (in `cell.ts` or similar) -- used for client-side
   `validateAndTransform`. Creates cell objects, adds `toCell` and `toOpaqueRef`
   symbols, handles `asCell`/`asStream` boundaries differently.

The v2 spec's traversal pseudocode hardcodes behavior equivalent to
`StandardObjectCreator`. If client-side traversal with cell creation is needed
in v2, the extensibility mechanism must be specified.

#### 5.2.5 `loadSource` / `loadLinkedRecipe`

`traverse.ts` has two functions for tracking provenance:

- `loadSource(tx, entry, cycleCheck, schemaTracker)` -- recursively loads
  `source` cells (pattern provenance). Follows `{ "/": shortId }` link objects
  in the `source` property.
- `loadLinkedRecipe(tx, entry, schemaTracker)` -- loads linked recipes/spells
  from doc values.

These add entries to the `schemaTracker` so that when the server determines
which entities to send to the client, the source/recipe entities are included.
This is critical for the Common Tools runtime where patterns need their source
code and recipes.

The v2 spec does not mention source/recipe tracking. If patterns still need
their provenance data delivered alongside query results, this must be specified.

#### 5.2.6 `ContextualFlowControl` (CFC)

The traverser takes a `ContextualFlowControl` parameter that controls schema
evaluation behavior:

- `cfc.schemaAtPath(schema, path, ...)` -- resolves the schema for a path
  within an object, with customizable "empty properties" and "missing property"
  markers.
- `ContextualFlowControl.isTrueSchema(schema)` -- checks if a schema is
  a "true schema" (accepts everything).
- `ContextualFlowControl.resolveSchemaRefs(schema)` -- resolves `$ref` within
  a schema.

This is used throughout `traverseObjectWithSchema`, `combineOptionalSchema`,
and `combineSchema`. The v2 spec's traversal pseudocode does not mention CFC.

#### 5.2.7 `DataCellURI` Creation for Inline Objects

When traversing arrays with schema, `traverse.ts` creates synthetic
`DataCellURI` identifiers for inline objects:

```typescript
curDoc = {
  ...curDoc,
  address: {
    ...curDoc.address,
    id: createDataCellURI(curDoc.value, elementLink),
    path: ["value"],
  },
};
```

This allows inline array elements to be treated as addressable entities. The
v2 spec does not describe this pattern.

#### 5.2.8 `LastNode` from Link Resolution

`traverse.ts` imports `LastNode` from `./link-resolution.ts` and uses it in
`followPointer` to track the final node in a link resolution chain. This
supports partial path resolution when a link target does not have the full
expected path structure.

#### 5.2.9 `getAtPath` Path Walking with Link Resolution

The actual `getAtPath` function in `traverse.ts` is significantly more complex
than the spec's "walk the path segments" description. It:

1. Walks path segments one at a time.
2. At each segment, checks if the current value is a link (`isPrimitiveCellLink`).
3. If it is a link, calls `followPointer` to resolve it.
4. If `followPointer` fails (target not found), attempts partial path
   resolution by backing up and trying intermediate documents.
5. Handles the `lastNode` parameter for tracking resolution chains.
6. Applies schema narrowing at each link hop.

### 5.3 Assessment

The v2 spec captures the **high-level architecture** of `traverse.ts`
accurately: cycle detection with compound keys, schema-guided traversal with
anyOf/allOf handling, schema narrowing at link boundaries, and the SchemaTracker
pattern.

However, the spec **under-specifies the reference resolution layer** which is
roughly half of `traverse.ts`'s complexity. The link format, write-redirect
handling, partial path resolution, `asCell`/`asStream` boundaries,
`IObjectCreator` extensibility, and source/recipe tracking are all absent.

This means that a v2 implementation based solely on the spec would produce a
traverser that works for simple reference-following scenarios but would fail
for the real-world patterns in the Common Tools runtime, which rely heavily on:

1. The specific link format (`{ "/": shortId }` objects).
2. Write-redirect chains for mutable references.
3. `asCell`/`asStream` boundaries for reactivity granularity.
4. Source/recipe inclusion for pattern provenance.

**Recommendation:** The spec should either:

1. Fully specify the reference format and link resolution algorithm (adapting
   the v1 format or defining a new one).
2. Explicitly state that the reference/link layer is out of scope and will be
   addressed in a separate spec, with the traversal spec assuming a
   `resolveReference(value): Entity | null` abstraction.

---

## 6. Summary Matrix

| Area | Lost | Gained | Changed | Migration Risk |
|---|---|---|---|---|
| Type dimension (`the`) | Yes | -- | -- | High |
| Patch operations | -- | Yes | -- | Low |
| Branching | -- | Yes | -- | Low |
| Binary blobs | -- | Yes | -- | Low |
| Point-in-time reads | -- | Yes | -- | Low |
| Snapshots | -- | Yes | -- | Low |
| Validation model | CAS semantics | Version-based | Design change | High |
| Changes structure | Nested tree | Flat operations | Design change | High |
| Session architecture | TransformStream | WebSocket/HTTP | Design change | High |
| Subscription matching | Pattern system | Under-specified | Gap | Medium |
| Schema subscriptions | Incremental eval | Under-specified | Gap | Medium |
| Link resolution | -- | -- | Not specified in v2 | **Critical** |
| `asCell`/`asStream` | -- | -- | Not specified in v2 | **Critical** |
| Source/recipe tracking | -- | -- | Not specified in v2 | High |
| ACL model | Full impl | Mentioned only | Under-specified | Medium |
| Commit history | Entity-based | Dedicated table | Design change | Medium |
| Database schema | 3 tables + view | 7 tables | Clean break | High (no migration path) |
