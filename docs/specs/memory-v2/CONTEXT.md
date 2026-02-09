# Memory v2 Spec — Shared Context for Agents

This file is the shared context for all agents writing the Memory v2 spec.
It is NOT part of the final spec — it's coordination material.

## Design Goals

1. **Clean break**: No backward compatibility with existing database, protocol, or client code.
2. **Boring nomenclature**: Replace cute terms with standard ones.
3. **Future commit model**: Implement the nursery/heap model from `02-commit-model.md` in the verifiable-execution spec. Use `version`-based validation instead of strict CAS hash matching.
4. **Incremental changes**: Transactions support patches (not just whole-document replacement). Store patches and replay them on retrieval. Support periodic snapshots for efficiency.
5. **Content-addressed immutable data (blobs)**: A new data kind — write-once, content-addressed, never changes. Has mutable metadata (specifically IFC labels, but keep it generic for now).
6. **Point-in-time retrieval**: Read any entity's state at any version number.
7. **Branching**: Create branches, write to branches, merge branches.
8. **Schema-based traversal**: Reuse patterns from `packages/runner/src/traverse.ts` for graph queries and subscriptions.

## Nomenclature Mapping

| Old Term | New Term | Notes |
|----------|----------|-------|
| `the` | *(dropped)* | Was always `application/json`. Type info lives in schema, not in the fact. |
| `of` | `id` | Entity identifier. URI format, e.g. `urn:entity:abc123` |
| `since` | `version` | Monotonic sequence number (Lamport clock). Per-space. |
| `cause` | `parent` | Reference to the previous fact in the causal chain. |
| `is` | `value` | The actual JSON data. |
| `Unclaimed` | `Empty` | The genesis state before any writes. |
| `Assertion` | `Write` | A fact that sets a value. |
| `Retraction` | `Delete` | A fact that removes a value (tombstone). |
| `MemorySpace` / Space | `Space` | A DID-identified namespace. `did:key:...` format. |
| `Commit` | `Commit` | Unchanged — a transaction record. |
| `Selection` | `Result` | Query result set. |
| `Selector` | `Query` | Query pattern. |
| `Fact` | `Fact` | Write | Delete — a single state transition. |
| `Changes` | `Operations` | The set of mutations in a transaction. |
| `FactSelection` | `FactSet` | A set of facts returned by queries. |
| `datum` (table) | `blob` | Content-addressed value storage. |
| `fact` (table) | `fact` | Fact history table. |
| `memory` (table) | `head` | Current state pointer per entity. |

## Fact Structure (New)

```typescript
// A fact records a single state transition for an entity
interface Write {
  id: EntityId;          // Entity this fact is about
  value: JSONValue;      // The data
  parent: Reference;     // Hash of previous fact (or Empty reference)
}

interface Delete {
  id: EntityId;
  parent: Reference;     // Hash of the Write being deleted
}

type Fact = Write | Delete;

// Stored with server-assigned metadata:
interface StoredFact extends Fact {
  hash: Reference;       // Content hash of this fact
  version: number;       // Lamport clock when committed
  commitHash: Reference; // Which commit included this fact
}
```

## Content-Addressed Blobs (New)

```typescript
// Immutable, content-addressed data. Never changes after creation.
interface Blob {
  hash: Reference;       // Content hash = identity
  data: Uint8Array;      // Raw bytes
  contentType: string;   // MIME type
  size: number;          // Byte length
}

// Mutable metadata about a blob (stored as a regular entity)
interface BlobMetadata {
  blob: Reference;       // Points to the blob
  labels: string[];      // IFC classification labels
  // ... other metadata fields TBD
}
```

## Incremental Changes (Patches)

Transactions can contain two kinds of operations per entity:

1. **`set`** — Full replacement. The value IS the new state.
2. **`patch`** — Incremental change. A list of operations applied to the current state.

Patch operations (JSON Patch subset + extensions):
- `{ op: "replace", path: "/foo/bar", value: 42 }` — Set a value at a path
- `{ op: "add", path: "/items/-", value: "new" }` — Append to array
- `{ op: "add", path: "/foo", value: "bar" }` — Add a field
- `{ op: "remove", path: "/foo" }` — Remove a field/element
- `{ op: "move", from: "/old", path: "/new" }` — Move a value
- `{ op: "splice", path: "/items", index: 2, remove: 1, add: ["a","b"] }` — Array splice (extension)

Storage strategy:
- Store patches as-is in the fact table (the `value` field contains the patch ops)
- Periodically create **snapshots** (full values) for fast reads
- On read: find nearest snapshot, replay patches forward
- On point-in-time read: find snapshot before target version, replay patches up to target

## Commit Model (Future Version)

Based on verifiable-execution spec section 5.10:

**Client state has two tiers:**
- **Confirmed** (was "heap"): Facts acknowledged by server, with real version numbers
- **Pending** (was "nursery"): Optimistic local writes, not yet confirmed

**Validation rule** (replaces strict CAS):
```
For each entity touched by a commit:
  commit.reads[entity].version >= server.head[entity].version
```

This means: "My reads are at least as fresh as the current server state."

**Stacked pending commits**: A client can create commit C2 that reads from
pending commit C1's writes. If C1 is rejected, C2 must also be rejected.

## Branching Model

- Every space has a default branch (unnamed, or `main`)
- Branches share the same entity ID space but have separate heads
- Branch operations: `create`, `merge`, `delete`
- Merge strategy: entity-level (not line-level), last-writer-wins with conflict detection
- Point-in-time reads specify: `(branch, version)` → state at that moment

## Query System

Reuse traverse.ts patterns:
- `SchemaPathSelector` → navigate JSON following schema
- Cycle detection for pointer traversal
- Schema narrowing as traversal follows links
- Subscriptions: server pushes incremental updates matching a query pattern

## Section Plan

| File | Content | Agent |
|------|---------|-------|
| `README.md` | Overview, goals, nomenclature, architecture diagram | Team Lead |
| `01-data-model.md` | Entities, Facts, Blobs, Metadata, References | Agent 1 |
| `02-storage.md` | DB schema, patches, snapshots, branches in storage | Agent 1 |
| `03-commit-model.md` | Transactions, confirmed/pending, validation, conflicts | Agent 2 |
| `04-protocol.md` | Wire protocol (WS/HTTP), message formats, auth | Agent 2 |
| `05-queries.md` | Selectors, schema traversal, subscriptions, PIT reads | Agent 3 |
| `06-branching.md` | Branch lifecycle, merge, isolation, time-travel | Agent 3 |
