# 01 — Data Model

This section defines the core data types of Memory v2: entities, facts,
references, blobs, patches, and snapshots. Every concept is accompanied by its
TypeScript type definition.

---

## 1. Entities

An **entity** is the fundamental unit of mutable state. Each entity is
identified by a URI and holds a JSON value that evolves over time through a
causal chain of facts.

```typescript
/**
 * Entity identifier. URI format, e.g. "urn:entity:abc123".
 * Unique within a space.
 */
type EntityId = `${string}:${string}`;
```

Key properties:

- An entity has **at most one current value** per branch (see §06 Branching).
- An entity's full history is the ordered sequence of facts referencing it.
- Entities are **untyped at the storage layer** — there is no MIME-type or `the`
  dimension. Type information lives in schemas, which are external to the fact
  store. This is a deliberate simplification over v1, where every fact carried a
  `the` (MIME type) field alongside its `of` (entity id).
- An entity that has never been written to is in the **Empty** state. The Empty
  state is represented by a well-known sentinel reference (see §3 References).

---

## 2. Facts

A **fact** records a single state transition for an entity. Facts are immutable
once created. There are three kinds of facts, distinguished by a discriminant
field:

### 2.1 Write

A **Write** fact asserts a new value for an entity. There are two sub-kinds of
writes depending on how the value is expressed:

```typescript
/**
 * A Write that sets the entity's value by full replacement.
 */
interface SetWrite {
  type: "set";
  id: EntityId;
  value: JSONValue;        // The complete new state
  parent: Reference;       // Hash of the previous fact, or EMPTY
}

/**
 * A Write that modifies the entity's value incrementally via patches.
 */
interface PatchWrite {
  type: "patch";
  id: EntityId;
  ops: PatchOperation[];   // Ordered list of patch operations
  parent: Reference;       // Hash of the previous fact, or EMPTY
}

type Write = SetWrite | PatchWrite;
```

### 2.2 Delete

A **Delete** fact tombstones an entity, removing its value. The entity can be
written to again after deletion — a delete is not permanent, it simply marks the
end of one value's lifetime.

```typescript
interface Delete {
  type: "delete";
  id: EntityId;
  parent: Reference;       // Hash of the Write or PatchWrite being deleted
}
```

### 2.3 Fact (union)

```typescript
type Fact = Write | Delete;
```

### 2.4 Stored Fact

When a fact is committed to a space, the server assigns additional metadata:

```typescript
interface StoredFact {
  /** Content hash of this fact's logical content (type, id, value/ops, parent). */
  hash: Reference;

  /** The fact itself. */
  fact: Fact;

  /** Monotonic version number (Lamport clock), assigned at commit time. Per-space. */
  version: number;

  /** Hash of the commit that included this fact. */
  commitHash: Reference;
}
```

- `version` is a space-global Lamport clock that increases monotonically with
  every commit. All facts in the same commit share the same version number.
- `commitHash` links the fact to its containing transaction record.

### 2.5 Causal Chain

Every entity's facts form a **causal chain**: a singly-linked list from the
current head back to the genesis Empty state. Each fact's `parent` field
contains the hash of the immediately preceding fact for that entity.

```
Empty ← fact₁ ← fact₂ ← fact₃ (head)
```

This chain is used for conflict detection (see §03 Commit Model) and for
point-in-time reconstruction.

---

## 3. References (Content Addressing)

A **Reference** is a content hash that uniquely identifies an immutable value.
References are computed using SHA-256 over a canonical merkle-tree encoding of
the value (the same `merkle-reference` algorithm used in v1).

```typescript
/**
 * An opaque, content-addressed identifier. Encoded as a multibase
 * base32-lower string prefixed with "b" (e.g. "bafk...").
 */
type Reference = string & { readonly __brand: unique symbol };
```

### 3.1 Hash Computation

Fact hashes are computed over the **logical content** of the fact. For a
`SetWrite`, this is `{ type, id, value, parent }`. For a `PatchWrite`, this is
`{ type, id, ops, parent }`. For a `Delete`, this is `{ type, id, parent }`.

The hash function produces a merkle reference by recursively building a tree
from the JSON value, then hashing the root. Primitive values are leaf nodes;
objects and arrays are interior nodes whose children are hashed first.

### 3.2 The Empty Reference

The **Empty** reference represents the genesis state before any writes. It is
computed as the merkle reference of the entity's identity:

```typescript
const EMPTY = refer({ id: entityId });
```

When a fact's `parent` equals the Empty reference for that entity, it is the
first fact in the entity's causal chain.

### 3.3 Reference Serialization

References are serialized as multibase base32-lower strings (prefix `b`). In
JSON contexts, they appear as plain strings. In the database, they are stored as
`TEXT`.

---

## 4. Content-Addressed Blobs

A **blob** is immutable, write-once binary data identified by its content hash.
Blobs are separate from entities — they never change after creation. They are
used for storing images, files, compiled artifacts, or any data that is
referenced by entities but should not be duplicated or versioned the same way.

```typescript
interface Blob {
  /** Content hash = identity. SHA-256 of the raw bytes. */
  hash: Reference;

  /** Raw binary content. */
  data: Uint8Array;

  /** MIME type, e.g. "image/png", "application/wasm". */
  contentType: string;

  /** Size in bytes (redundant with data.length, stored for indexing). */
  size: number;
}
```

Key properties:

- **Immutable**: Once a blob is stored, it never changes. Its hash is its
  identity — if the content changes, it's a different blob.
- **Deduplicated**: Two identical byte sequences produce the same hash and are
  stored once.
- **No history**: Blobs have no causal chain, no version numbers, no patches.
  They simply exist or don't.
- **Separate table**: Blobs live in their own storage table (`blob_store`),
  distinct from entity facts. See §02 Storage for the schema.

### 4.1 Referencing Blobs from Entities

Entity values can reference blobs by including the blob's hash as a field value.
The convention is:

```typescript
// An entity value that references a blob
{
  "$blob": "bafk...",   // Reference to the blob's content hash
  "filename": "photo.jpg",
  "alt": "A photo"
}
```

The `$blob` field is a convention, not enforced by the storage layer. Schemas
can validate that blob references resolve to actual blobs.

---

## 5. Blob Metadata

Blobs themselves are immutable, but metadata about blobs (classification labels,
descriptions, access policies) is mutable. Blob metadata is stored as a
**regular entity** whose `id` is derived from the blob's content hash.

```typescript
/**
 * Derives the entity ID used to store metadata for a given blob.
 */
function blobMetadataId(blobHash: Reference): EntityId {
  return `urn:blob-meta:${blobHash}`;
}
```

The metadata entity's value follows this shape:

```typescript
interface BlobMetadata {
  /** The blob this metadata describes. */
  blob: Reference;

  /** IFC classification labels for information flow control. */
  labels: string[];

  // Future: additional metadata fields (description, provenance, etc.)
}
```

Because metadata is a regular entity, it benefits from all entity features:
versioning, causal chains, patches, conflict detection, point-in-time reads, and
branch isolation.

---

## 6. Incremental Operations (Patches)

Memory v2 supports two mutation modes for entity values:

### 6.1 Set (Full Replacement)

A `set` operation replaces the entity's entire value. The new value IS the
complete state. This is semantically identical to v1 assertions.

### 6.2 Patch (Incremental Change)

A `patch` operation applies a list of fine-grained operations to the entity's
current value. Patches use a subset of [JSON Patch (RFC 6902)](https://datatracker.ietf.org/doc/html/rfc6902)
plus a custom `splice` extension for efficient array manipulation.

```typescript
/**
 * A JSON Pointer path, e.g. "/foo/bar/0".
 */
type JSONPointer = string;

/**
 * Standard JSON Patch operations (RFC 6902 subset).
 */
interface ReplaceOp {
  op: "replace";
  path: JSONPointer;
  value: JSONValue;
}

interface AddOp {
  op: "add";
  path: JSONPointer;
  value: JSONValue;
}

interface RemoveOp {
  op: "remove";
  path: JSONPointer;
}

interface MoveOp {
  op: "move";
  from: JSONPointer;
  path: JSONPointer;
}

/**
 * Extension operation: array splice.
 * More efficient than expressing insert/delete as individual add/remove ops.
 */
interface SpliceOp {
  op: "splice";
  path: JSONPointer;       // Path to the target array
  index: number;           // Start index
  remove: number;          // Number of elements to remove
  add: JSONValue[];        // Elements to insert at the index
}

type PatchOperation = ReplaceOp | AddOp | RemoveOp | MoveOp | SpliceOp;
```

### 6.3 Patch Application Semantics

Patches are applied **in order**, left to right. Each operation in the list
transforms the state produced by the previous operation. If any operation in the
patch list is invalid (e.g., removing a non-existent path), the entire patch
fails and the fact is rejected.

```typescript
function applyPatch(state: JSONValue, ops: PatchOperation[]): JSONValue {
  let current = state;
  for (const op of ops) {
    current = applyOp(current, op);
  }
  return current;
}
```

### 6.4 Patch Composition

Multiple sequential patches can be **composed** into a single equivalent patch
for optimization, but the storage layer does not perform this automatically.
Patches are stored as-is.

When replaying patches for a read, each patch's operations are applied
sequentially to the state produced by the previous fact:

```
snapshot_v10 → apply(patch_v11) → apply(patch_v12) → ... → current_state
```

### 6.5 Patches in Facts

A `PatchWrite` fact stores its patch operations directly. The fact's content
hash covers the full patch operation list, ensuring integrity.

In the storage layer, patch operations are serialized as JSON and stored as a
blob (content-addressed in the `blob` table). The fact table references this
blob via a `value_ref` column. See §02 Storage for details.

---

## 7. Snapshots

A **snapshot** is a materialized full value of an entity at a specific version.
Snapshots accelerate reads by avoiding full replay of the entity's entire patch
history.

```typescript
interface Snapshot {
  /** The entity this snapshot is for. */
  id: EntityId;

  /** The version (Lamport clock) at which this snapshot was taken. */
  version: number;

  /** Reference to the full value blob in the blob table. */
  valueRef: Reference;

  /** Branch this snapshot belongs to (see §06 Branching). */
  branch: string;
}
```

### 7.1 Snapshot Creation Policy

Snapshots are created **periodically** based on a configurable policy. The
default policy is: create a snapshot every **N patches** per entity (e.g., every
10 patches). The snapshot interval is a space-level configuration.

```typescript
interface SnapshotPolicy {
  /** Create a snapshot after this many patches since the last snapshot. */
  patchInterval: number;  // Default: 10
}
```

Snapshots can also be created on-demand (e.g., for frequently-read entities or
before archiving).

### 7.2 Read Path with Snapshots

To read an entity's current value:

1. Find the most recent snapshot for the entity on the target branch.
2. Collect all `PatchWrite` facts with `version > snapshot.version` up to the
   head.
3. Start from the snapshot value and apply each patch in version order.
4. If no snapshot exists, start from the first `SetWrite` fact and replay all
   subsequent patches.

For point-in-time reads at a specific version:

1. Find the most recent snapshot with `version <= targetVersion`.
2. Collect patches in `(snapshot.version, targetVersion]`.
3. Replay from snapshot through patches.

See §02 Storage for the SQL queries that implement this.

### 7.3 Snapshot Invariants

- A snapshot's value MUST equal the result of replaying all facts from genesis
  up to `snapshot.version`.
- Snapshots are **redundant** — they can always be recomputed from the fact
  history. Deleting a snapshot never loses data; it only makes reads slower.
- Snapshots are per-branch. A snapshot on branch A does not apply to branch B
  unless the versions coincide exactly.

---

## 8. Type System

### 8.1 No Type Dimension in Storage

In v1, every fact carried a `the` field (MIME type, always `application/json`)
alongside its `of` (entity id). This created a two-dimensional key space
`(the, of)` for entity identity.

In v2, we drop the `the` dimension entirely. An entity is identified solely by
its `id`. There is no MIME type stored per fact.

**Rationale**: The `the` field was always `application/json` in practice. Type
information is better expressed in schemas, which describe the shape of entity
values without coupling storage to content types.

### 8.2 Schemas

Schemas define the expected structure of entity values. They are stored as
regular entities (self-describing: a schema is an entity whose value is a JSON
Schema).

```typescript
// A schema entity's value is a JSON Schema
interface SchemaEntity {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  type: "object";
  properties: Record<string, JSONSchema>;
  // ... standard JSON Schema fields
}
```

Schemas are used for:

- **Validation**: Ensuring that writes conform to expected shapes.
- **Traversal**: Following links between entities (pointer fields that reference
  other entities by id).
- **Query optimization**: Schema-aware queries can pre-fetch linked entities.

Schema-based traversal is covered in §05 Queries.

### 8.3 Entity-Schema Binding

The binding between an entity and its schema is **not** stored in the fact
table. Instead, it is established by convention or by a schema registry (a
well-known entity that maps entity id patterns to schema entity ids).

This decoupling means:

- The storage layer is schema-agnostic. It stores JSON values without
  validation.
- Validation is performed by higher layers (the runtime, the client).
- An entity's schema can evolve independently of its data.
