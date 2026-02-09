# 5. Queries

This section defines how clients retrieve data from a Space. The query system
supports simple pattern matching, schema-driven graph traversal, point-in-time
reads, subscriptions, and classification-based access control.

## 5.1 Query Types

There are two query types, each with increasing expressiveness:

1. **Simple queries** -- match entities by id and filter by version range.
2. **Schema queries** -- follow references between entities guided by a JSON
   Schema, reusing the traversal patterns from `traverse.ts`.

Both query types can be issued as one-shot requests or as persistent
subscriptions.

```typescript
// Base query options shared by all query types
interface QueryOptions {
  branch?: BranchName;     // Target branch (default branch if omitted)
  atVersion?: number;      // Point-in-time read (latest if omitted)
}
```

---

## 5.2 Simple Queries

A simple query matches entities by id and optionally filters by version range.
This is the lightweight path for clients that know exactly which entities they
need.

### 5.2.1 Query Structure

```typescript
interface Query extends QueryOptions {
  // Match patterns, keyed by entity id.
  // Use "*" as the id to match all entities.
  select: Record<EntityId | "*", EntityMatch>;
}

interface EntityMatch {
  // Empty object means "match any version."
  // If omitted entirely, treated as empty object.
  [key: string]: unknown;
}
```

**Matching rules:**

| `select` key | Behavior |
|---|---|
| Specific id (e.g. `"urn:entity:abc123"`) | Match exactly that entity |
| `"*"` (wildcard) | Match all entities in the space |

When using the wildcard `"*"` selector, the server MAY impose a fan-out limit
(e.g., 10,000 entities) to prevent excessive memory use. If the limit is
exceeded, the server returns a paginated result (see section 5.8) rather than an
error.

### 5.2.2 Version Filtering

The `since` parameter enables incremental synchronization. When provided, the
server returns only facts with `version > since`.

```typescript
interface IncrementalQuery extends Query {
  since?: number;  // Only return facts newer than this version
}
```

This is the primary mechanism for keeping a client in sync: after an initial
full query, subsequent queries use the highest version seen as the `since`
value.

### 5.2.3 Simple Query Execution

Given a `Query`, the server:

1. Identifies the target branch (default if unspecified).
2. For each pattern in `select`:
   - If the key is `"*"`, iterate all entities on the branch.
   - If the key is a specific id, look up that entity's head on the branch.
3. For each matched entity, read its current head fact.
4. If `since` is provided, skip entities whose head version is <= `since`.
5. If `atVersion` is provided, reconstruct the entity state at that version
   (see section 5.5).
6. Apply classification checks (see section 5.6).
7. Assemble and return a `FactSet`.

---

## 5.3 Schema Queries

Schema queries extend simple queries with JSON Schema-driven graph traversal.
Starting from a set of root entities, the server follows references embedded in
entity values, guided by a schema that constrains which paths to explore and
which linked entities to include.

The traversal code in `packages/runner/src/traverse.ts` is **shared between
client and server**. The v1 server (`space-schema.ts`) imports
`SchemaObjectTraverser` from `@commontools/runner/traverse`, and the client
(`schema.ts`) uses the same code for validation and transformation. This
ensures identical traversal behavior on both sides. The v2 implementation MUST
preserve this shared-code property.

### 5.3.1 Schema Query Structure

```typescript
interface SchemaQuery extends QueryOptions {
  selectSchema: SchemaSelector;
  since?: number;
  classification?: string[];  // IFC claims for access control
  limits?: SchemaQueryLimits;
}

interface SchemaQueryLimits {
  maxDepth?: number;      // Maximum traversal depth (default: 10)
  maxEntities?: number;   // Maximum entities to visit (default: 1000)
}

// SchemaSelector maps entity ids to schema path selectors.
// The path+schema pair applies directly per entity.
type SchemaSelector = Record<EntityId | "*", SchemaPathSelector>;

// A path + schema pair that describes what to traverse
// within a matched entity's value.
interface SchemaPathSelector {
  path: string[];          // Path segments into the entity value
  schema?: JSONSchema;     // JSON Schema constraining traversal
}
```

The `path` field navigates into the entity's value before applying the schema.
For example, `{ path: ["settings", "theme"], schema: { type: "object" } }`
would navigate to the `settings.theme` sub-object and traverse it as an object.

### 5.3.2 Schema Traversal Algorithm

Schema traversal follows the patterns established in `traverse.ts`, adapted for
the Memory v2 data model. The algorithm has three key components: path
following, schema-guided filtering, and reference resolution.

#### Path Following

Starting from a matched entity's value, the traverser walks the `path` segments
from the `SchemaPathSelector`:

1. At each step, descend into the current value using the next path segment.
2. If the current value is a reference (link to another entity), resolve it
   before continuing.
3. Once all path segments are consumed, begin schema-guided traversal on the
   resulting value.

This mirrors the `getAtPath` function from `traverse.ts`, which walks a
document path while resolving references encountered along the way.

#### Schema-Guided Filtering

Once at the target path, the traverser applies the JSON Schema to determine
which parts of the value to include and which references to follow:

```
function traverseWithSchema(value, schema):
  if schema is true or {}:
    // Accept everything -- traverse the full DAG
    return traverseDAG(value)

  if schema is false:
    // Reject -- skip this subtree
    return undefined

  if schema.type == "object":
    result = {}
    for each property in value:
      propSchema = schemaAtPath(schema, [property])
      if propSchema is not false:
        result[property] = traverseWithSchema(value[property], propSchema)
      else:
        // Property not in schema -- include raw value without following refs
        result[property] = value[property]
    // Apply defaults for missing required properties
    return result

  if schema.type == "array":
    result = []
    for each item in value:
      itemSchema = schema.items
      result.push(traverseWithSchema(item, itemSchema))
    return result

  if schema.anyOf:
    // Try each option, merge matches (object property union)
    matches = []
    for each option in schema.anyOf:
      match = traverseWithSchema(value, merge(schema, option))
      if match != undefined:
        matches.push(match)
    return mergeAnyOfMatches(matches)

  if schema.allOf:
    // All must match
    for each option in schema.allOf:
      if traverseWithSchema(value, merge(schema, option)) == undefined:
        return undefined  // mismatch
    return last successful result

  // Primitive types: validate and return
  if typeMatches(value, schema.type):
    return value
  return undefined
```

This mirrors the `SchemaObjectTraverser.traverseWithSchema` method from
`traverse.ts`.

#### Reference Resolution

When the traverser encounters a reference (a value that points to another
entity), it:

1. **Parses the reference** to extract the target entity id and sub-path.
2. **Checks the cycle tracker** to prevent infinite loops when following
   circular references.
3. **Loads the target entity** from the store.
4. **Narrows the schema** for the target entity. The schema from the referencing
   context is combined with any schema embedded in the reference itself using
   schema intersection (see 5.3.3).
5. **Continues traversal** on the target entity's value with the narrowed
   schema.

This mirrors the `followPointer` function from `traverse.ts`.

### 5.3.3 Cycle Detection

Graph traversal must handle cycles. Two cycle detection mechanisms are used,
both derived from `traverse.ts`:

#### CycleTracker

Tracks visited nodes by identity. If a node is visited twice during the same
traversal path, the second visit returns `null` (cycle detected, do not
descend).

```typescript
class CycleTracker<K> {
  private visiting: Set<K>;

  // Returns a disposable scope if not a cycle, or null if cycle detected.
  // On dispose, removes the key so parallel branches can visit the same node.
  include(key: K): Disposable | null;
}
```

#### CompoundCycleTracker

A more nuanced tracker that considers both node identity and schema context.
The same entity can be visited multiple times with different schemas without
triggering a false cycle. This is important because a single entity may be
reachable via different schema paths that expose different subsets of its data.

```typescript
class CompoundCycleTracker<IdentityKey, SchemaKey, Value> {
  // Returns null if this (identityKey, schemaKey) pair has been visited.
  // Uses identity equality for identityKey, deep equality for schemaKey.
  include(
    identityKey: IdentityKey,
    schemaKey: SchemaKey,
    value?: Value
  ): Disposable | null;

  // After a failed include, retrieve the value registered by the first visit.
  getExisting(identityKey: IdentityKey, schemaKey: SchemaKey): Value | undefined;
}
```

In practice, the traverser uses a `CompoundCycleTracker` parameterized as:

```typescript
type PointerCycleTracker = CompoundCycleTracker<
  JSONValue,       // The reference value (identity comparison)
  JSONSchema,      // The schema context (deep equality comparison)
  any              // The traversal result for this node
>;
```

### 5.3.4 Schema Narrowing

When following a reference from entity A to entity B, the schema applicable to
B is the **intersection** of:

1. The schema context from A's traversal (what A expects B to look like).
2. Any schema embedded in the reference itself (what the reference declares B
   to contain).

This intersection is computed by `combineSchema`:

```
combineSchema(parentSchema, linkSchema):
  if parentSchema is true/{}:
    return linkSchema  (parent accepts anything, use link's constraint)

  if linkSchema is true/{}:
    return parentSchema  (link accepts anything, use parent's constraint)

  if both are type:"object":
    // Intersect properties: for shared property keys, recurse combineSchema.
    // For properties only in one schema, combine with the other's
    // additionalProperties.
    mergedProperties = {}
    for each key in union(parentSchema.properties, linkSchema.properties):
      mergedProperties[key] = combineSchema(
        parentSchema.properties[key] ?? parentSchema.additionalProperties,
        linkSchema.properties[key] ?? linkSchema.additionalProperties
      )
    return { type: "object", properties: mergedProperties, ... }

  if both are type:"array":
    return { type: "array", items: combineSchema(parent.items, link.items) }

  // Fallback: prefer parent schema with link's metadata flags
  return parentSchema
```

This mirrors the `combineSchema` and `narrowSchema` functions from
`traverse.ts`.

### 5.3.5 Schema Tracker

During traversal, the server records which entities were visited and with what
schema context. This information is stored in a `SchemaTracker` (a `MapSet`
mapping entity keys to `SchemaPathSelector` sets):

```typescript
type SchemaTracker = MapSet<
  string,                // Key: "{space}/{entityId}"
  SchemaPathSelector     // The schema+path used when visiting this entity
>;
```

The schema tracker serves two purposes:

1. **Subscription bookkeeping** -- after the initial query, the server knows
   exactly which entities are reachable from the query roots. When any of these
   entities change, the subscription is notified.
2. **Incremental update evaluation** -- when an entity changes, the server
   re-evaluates its links using the stored schema to determine whether new
   entities have become reachable (or old ones unreachable).

### 5.3.6 Schema Query Execution

Given a `SchemaQuery`, the server:

1. Identifies the target branch.
2. Iterates the `selectSchema` patterns to find root entities (same matching
   rules as simple queries).
3. For each root entity:
   a. Loads the entity's current value.
   b. Applies classification checks (see 5.6) to the root entity.
   c. Runs the schema traversal algorithm (5.3.2), which recursively loads and
      filters linked entities.
   d. Records all visited entities in the schema tracker.
4. Collects all visited entities and their values into the result `FactSet`.
5. If `since` is provided, filters the result to only include entities whose
   version exceeds `since`.
6. Returns the `FactSet` along with the schema tracker (for subscription
   setup).

---

## 5.4 Subscriptions

Subscriptions provide a persistent query that receives incremental updates as
the matching data changes. Both simple and schema queries support subscriptions.

### 5.4.1 Subscription Lifecycle

```
Client                                Server
  |                                     |
  |--- subscribe(query) -------------->|
  |                                     |-- execute initial query
  |<--- initial FactSet ---------------|
  |                                     |
  |     (data changes on server)        |
  |<--- incremental FactSet -----------|
  |                                     |
  |     (more changes)                  |
  |<--- incremental FactSet -----------|
  |                                     |
  |--- unsubscribe(subscriptionId) --->|
  |<--- ok ----------------------------|
```

### 5.4.2 Simple Subscriptions

For simple queries, the server:

1. Executes the initial query and returns the result.
2. Records the query's entity match patterns and the highest version sent.
3. On each commit:
   a. Check if any committed facts match the subscription's patterns.
   b. If so, send only the changed facts as an incremental `FactSet`.
   c. Update the highest version sent.

Matching uses the same rules as `subscription.ts`: an entity matches if its id
(or the wildcard `*`) intersects with the subscription pattern.

### 5.4.3 Schema-Aware Subscriptions

Schema subscriptions are more sophisticated because the set of relevant
entities can change as data changes. A reference that previously pointed to
entity X might now point to entity Y, meaning Y's changes should trigger
updates.

The server manages this by maintaining the **schema tracker** from the initial
query:

1. **Initial query**: execute the schema query, build the schema tracker. The
   tracker records every entity visited and the schema context used.
2. **On commit**: for each changed entity:
   a. Check if the entity appears in the schema tracker. If yes, the
      subscription is affected.
   b. If the changed entity contains references, re-evaluate its links using
      `evaluateDocumentLinks` to discover any newly reachable entities.
   c. Update the schema tracker with any new entity/schema pairs.
   d. Remove entity/schema pairs that are no longer reachable.
3. **Send update**: collect all changed and newly reachable entities into an
   incremental `FactSet` and send to the client.

This mirrors the `evaluateDocumentLinks` function from `space-schema.ts`, which
re-evaluates a single entity's outgoing references under a given schema.

### 5.4.4 Deduplication

The server tracks what has been sent to each subscription to avoid sending
duplicate data:

- **Version watermark**: for simple subscriptions, the highest version sent acts
  as a watermark. Only facts with version > watermark are sent.
- **Sent entity set**: for schema subscriptions, the server additionally tracks
  which entities have been sent in this subscription session. When
  `excludeSent: true` is set in the query, entities already sent are omitted
  from incremental updates unless their value has changed.

### 5.4.5 Update Coalescing

When multiple commits occur in rapid succession, the server MAY coalesce
subscription updates. Instead of sending one update per commit, the server
batches changes and sends a single update covering all commits since the last
sent update. The coalesced update includes the latest `FactEntry` per entity,
not intermediate states.

### 5.4.6 Subscription State

```typescript
interface SubscriptionState {
  id: string;                                // Unique subscription identifier
  query: Query | SchemaQuery;                // The subscribed query
  branch: BranchName;                        // Target branch
  lastVersionSent: number;                   // Version watermark
  schemaTracker?: SchemaTracker;             // For schema subscriptions
  sentEntities?: Set<string>;                // For excludeSent optimization
}
```

---

## 5.5 Point-in-Time Queries

A point-in-time query reconstructs the state of entities at a specific version
on a specific branch. This is specified via the `atVersion` field in
`QueryOptions`.

### 5.5.1 Reconstruction Algorithm

For each matched entity at `atVersion`:

1. **Find the nearest snapshot** at or before the target version. A snapshot is
   a stored full-value checkpoint of the entity at a specific version.
2. **Collect patches** between the snapshot version and the target version.
   These are the incremental operations (JSON Patch operations) stored as facts
   with version in the range `(snapshotVersion, targetVersion]`.
3. **Replay patches** on the snapshot value in version order to reconstruct the
   entity's state at the target version.
4. If the entity was deleted (a `Delete` fact) at or before the target version,
   return the tombstone state.

```
state(entity, targetVersion):
  snapshot = findLatestSnapshot(entity, branch, targetVersion)
  patches = findPatches(entity, branch, snapshot.version, targetVersion)

  value = snapshot.value
  for each patch in patches (ordered by version ascending):
    if patch is Delete:
      return DeletedState
    value = applyPatch(value, patch.operations)
  return value
```

### 5.5.2 Efficiency Considerations

- **Snapshot frequency**: the server periodically creates snapshots to bound the
  number of patches that must be replayed. A reasonable default is one snapshot
  every N versions per entity (e.g. N=100).
- **No snapshot available**: if no snapshot exists for an entity, reconstruction
  starts from the entity's first `Write` fact (which is always a full value,
  acting as an implicit snapshot).
- **Version 0**: querying at version 0 returns the initial state (typically
  empty for all entities).

### 5.5.3 Point-in-Time with Schema Queries

Point-in-time reads compose with schema queries. The schema traversal operates
on the reconstructed values, following references to other entities that are
themselves reconstructed at the same target version. This provides a consistent
snapshot of the entire reachable graph at a single point in time.

---

## 5.6 Classification and Redaction

Entities may have associated blob metadata with IFC (Information Flow Control)
labels. The query system enforces these labels to prevent unauthorized data
access.

### 5.6.1 Classification Model

Each entity can have a `BlobMetadata` record that specifies classification
labels:

```typescript
interface BlobMetadata {
  blob: Reference;      // The blob this metadata describes
  labels: string[];     // Classification labels (e.g. ["confidential", "pii"])
}
```

Clients declare their classification claims in the query:

```typescript
interface SchemaQuery {
  classification?: string[];  // e.g. ["confidential"]
}
```

### 5.6.2 Access Check Algorithm

During query execution, for each entity to be included in the result:

1. Load the entity's blob metadata (if any).
2. Extract the set of required classification labels.
3. Compare against the caller's declared claims.
4. If the required labels are a subset of the caller's claims, include the
   entity in the result.
5. If not, **omit** the entity from the result entirely. Do not return an error
   -- the entity is silently redacted.

```typescript
function checkClassification(
  requiredLabels: Set<string>,
  callerClaims: Set<string>
): boolean {
  return requiredLabels.isSubsetOf(callerClaims);
}
```

### 5.6.3 Redaction in Commits

When a subscription sends incremental updates that include commit data, the
commit's changes are redacted based on the subscriber's claims. Entities that
the subscriber cannot access are stripped from the commit before sending:

```
redactCommit(commit, subscriberClaims):
  for each entity in commit.changes:
    labels = getLabels(entity)
    if not labels.isSubsetOf(subscriberClaims):
      remove entity from commit.changes
  return commit
```

This mirrors the `redactCommits` function from `space-schema.ts`.

---

## 5.7 Result Format

All queries return results as a `FactSet` -- a structured collection of facts
organized by entity.

### 5.7.1 FactSet Structure

```typescript
// The top-level result: space -> entity facts
interface QueryResult {
  [spaceId: string]: FactSet;
}

// Facts organized by entity id
interface FactSet {
  [entityId: EntityId]: FactEntry;
}

// A single fact entry in the result
interface FactEntry {
  value?: JSONValue;   // The entity value (absent for deletes/tombstones)
  version: number;     // The version when this fact was committed
  hash: Reference;     // Hash of the current head fact
}
```

### 5.7.2 Result Semantics

- **Present entity**: has a `FactEntry` with `value` populated. The `hash`
  field identifies the head fact.
- **Deleted entity**: has a `FactEntry` without `value` (tombstone). The `hash`
  still identifies the delete fact.
- **Unknown entity**: no entry in the `FactSet` at all.

---

## 5.8 Pagination

For queries that match large numbers of entities, the server supports
cursor-based pagination.

### 5.8.1 Pagination Parameters

```typescript
interface PaginatedQuery extends Query {
  limit?: number;       // Maximum entities to return (default: server-chosen)
  cursor?: string;      // Opaque continuation token from a previous response
}
```

### 5.8.2 Pagination Response

```typescript
interface PaginatedResult {
  facts: FactSet;
  cursor?: string;      // Present if more results are available
  hasMore: boolean;      // Explicit flag for client convenience
}
```

### 5.8.3 Pagination Semantics

- The cursor is opaque to the client. The server may encode the last entity id
  and version, or any other state needed to resume iteration.
- Pagination is **version-consistent**: the server pins the query to the version
  at which the first page was served, so subsequent pages reflect the same
  snapshot.
- Schema queries paginate over root entities. Linked entities reachable from a
  root are always included in the same page as that root.

---

## 5.9 Branch-Aware Queries

All queries operate on a specific branch. If no branch is specified, the
default branch is used.

### 5.9.1 Branch Resolution

```typescript
interface QueryOptions {
  branch?: BranchName;  // Omit for default branch
}
```

The server resolves the branch name to a branch record (see `06-branching.md`),
then reads entity heads from that branch's head table. All entity state lookups
use the branch-scoped heads.

### 5.9.2 Cross-Branch Queries

The query system does not support querying across multiple branches in a single
request. To compare entities between branches, the client must issue separate
queries targeting each branch.

### 5.9.3 Branch + Point-in-Time

Branch and version interact naturally: `{ branch: "feature-x", atVersion: 42 }`
reads the state of the `feature-x` branch as it was at version 42. The
reconstruction algorithm (5.5) scopes its fact lookup to the specified branch.

---

## 5.10 Entity References and Links

Entity values may contain references (links) to other entities. This section
defines the reference formats used in the query and traversal system.

### 5.10.1 Link Format

A reference embedded in an entity value uses the CID link format -- a JSON
object with a single `"/"` key:

```typescript
// A reference/link embedded in an entity value
interface EntityLink {
  "/": Reference;  // Content-addressed reference to a fact or entity
}
```

Example:

```json
{
  "author": { "/": "bafy...abc123" },
  "title": "My Document"
}
```

### 5.10.2 Link Resolution

Given a link, the traverser:

1. Extracts the `Reference` from the `"/"` key.
2. Looks up the entity whose current head fact has that hash.
3. Loads the target entity's value and continues traversal with the appropriate
   schema context (see 5.3.4 Schema Narrowing).

### 5.10.3 Entity ID References

Values can also reference entities by ID directly as a string field. The schema
determines which fields are entity ID references versus plain strings. Schema
properties marked with `$ref` or with a custom `x-entity-reference: true`
annotation indicate fields that should be followed as links during traversal.

```json
{
  "type": "object",
  "properties": {
    "owner": {
      "type": "string",
      "x-entity-reference": true
    }
  }
}
```

The traversal algorithm in section 5.3.2 uses both formats. Content-addressed
links (`{ "/": "<reference>" }`) are detected structurally. Entity ID references
require schema annotations to distinguish them from plain string values.

---

## 5.11 Reactivity Boundaries

When schema traversal encounters a reference and resolves it to another entity,
the resolved entity becomes a separate **reactive unit**. This section defines
how reactivity boundaries interact with the query system.

### 5.11.1 asCell

`asCell(entityId)` returns a reactive cell that updates when the entity's head
changes. The cell holds the entity's current value and re-evaluates when a new
fact is committed for that entity on the target branch.

### 5.11.2 asStream

`asStream(query)` returns a reactive stream of `FactSet` updates. Each emission
contains the incremental changes since the last emission, following the
subscription semantics defined in section 5.4.

### 5.11.3 Boundary Rules

The boundary between "data included in the parent cell" and "data in a separate
cell" is determined by the schema:

- **Top-level properties** of a queried entity are part of the parent cell's
  reactive scope. Changes to these properties trigger an update on the parent
  cell.
- **Referenced entities** (followed via links) are separate cells. Changes to a
  referenced entity trigger an update on that entity's cell, but do not
  automatically trigger an update on the referencing (parent) cell.
- **Schema-aware subscriptions** (section 5.4.3) bridge this boundary: the
  schema tracker monitors all reachable entities, so the subscription stream
  emits updates for any change in the reachable graph.

---

## 5.12 Implementation Notes

This section documents constraints and considerations discovered during an
initial v1 → v2 migration that affect how queries and subscriptions are
implemented.

### 5.12.1 Schema Traversal Is a Server-Side Function

In v1, schema-guided graph traversal happens on the **server** via
`space-schema.ts` → `selectSchema()`. The server walks from root entities
through `{"/": { "link@1": {...} } }` references, guided by the JSON schema,
and returns ALL linked entities in a single query response. The client never
needs to "discover" linked entities — the server already includes them.

The client-side `SchemaObjectTraverser` in `traverse.ts` is used for
**validating and transforming** already-loaded data (e.g., in `schema.ts`),
not for discovering what to subscribe to. Any v2 query implementation must
preserve this server-side traversal pattern.

### 5.12.2 Schema Availability

Not all cells carry schemas. In the runner's `StorageManager.syncCell()`, the
selector is built as:

```typescript
const selector = {
  path: cell.path.map((p) => p.toString()),
  schema: schema ?? false,
};
```

When a cell has no schema (common for many cell types), the selector becomes
`{ path: [...], schema: false }`. Per section 5.3.2, `schema: false` means
"reject — skip this subtree." A traverser with `schema: false` will not follow
any references or discover any linked entities.
