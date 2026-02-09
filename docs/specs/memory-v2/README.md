# Memory v2 Specification

A complete, clean-break redesign of the Memory system — the persistent,
transactional, content-addressed store that underlies the Common Tools runtime.

## Design Goals

1. **Clean break** — No backward compatibility with the v1 database, protocol,
   or client code. Fresh start.
2. **Boring nomenclature** — Replace the cute v1 terms (`the`, `of`, `since`,
   `cause`) with standard ones (`id`, `version`, `parent`). Drop the `the`
   dimension entirely (it was always `application/json`).
3. **Incremental changes** — Transactions support patches (JSON Patch + splice
   extension), not just whole-document replacement. Patches are stored as-is and
   replayed on read, with periodic snapshots for efficiency.
4. **Content-addressed blobs** — Immutable, write-once binary data with mutable
   metadata (IFC labels). Stored separately from entities.
5. **Point-in-time retrieval** — Read any entity's state at any version number
   on any branch.
6. **Branching** — Lightweight branches with isolation, merging, and conflict
   detection. Branches share the fact history (O(1) creation).
7. **Future commit model** — Implements the confirmed/pending (was heap/nursery)
   client state model with version-based validation (replacing strict CAS).
8. **Schema-based traversal** — Graph queries follow JSON Schema-defined
   references, reusing `traverse.ts` patterns (cycle detection, schema
   narrowing).

## Nomenclature

| v1 Term | v2 Term | Description |
|---------|---------|-------------|
| `the` | *(dropped)* | Was always `application/json`. No type dimension in v2. |
| `of` | `id` | Entity identifier (URI) |
| `since` | `version` | Monotonic sequence number (Lamport clock) |
| `cause` | `parent` | Reference to previous fact in causal chain |
| `is` | `value` | The JSON data |
| `Unclaimed` | `Empty` | Genesis state before any writes |
| `Assertion` | `Write` (`set` or `patch`) | A fact that sets/patches a value |
| `Retraction` | `Delete` | Tombstone fact |
| `Changes` | `Operation[]` | Flat list of typed operations |
| `Selection` | `FactSet` | Query result set |
| `Selector` | `Query` / `Selector` | Query pattern |
| `datum` table | `value` table | Content-addressed JSON value storage |
| `memory` table | `head` table | Current state pointer per entity per branch |
| Heap | Confirmed | Server-acknowledged client state |
| Nursery | Pending | Optimistic unconfirmed client state |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Client                                │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Confirmed   │  │   Pending    │  │   Client Library   │  │
│  │  (version,   │  │  (stacked    │  │  connect()         │  │
│  │   hash,      │  │   commits,   │  │  session.transact()│  │
│  │   value)     │  │   provisional│  │  session.query()   │  │
│  │              │  │   hashes)    │  │  session.subscribe()│ │
│  └──────────────┘  └──────────────┘  └─────────┬─────────┘  │
│                                                 │            │
└─────────────────────────────────────────────────┼────────────┘
                                                  │ WebSocket / HTTP
┌─────────────────────────────────────────────────┼────────────┐
│                       Server                    │            │
│                                                 ▼            │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   Protocol Layer                        │ │
│  │  UCAN auth, message routing, subscription management    │ │
│  └────────────────────────┬────────────────────────────────┘ │
│                           │                                  │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │                   Commit Engine                         │ │
│  │  Version-based validation, atomic application,          │ │
│  │  conflict detection, branch-aware commits               │ │
│  └────────────────────────┬────────────────────────────────┘ │
│                           │                                  │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │                   Storage (SQLite)                      │ │
│  │  Per-space database, tables:                            │ │
│  │  value | fact | head | commit | snapshot | branch       │ │
│  │  blob_store (immutable binary blobs)                    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   Query Engine                          │ │
│  │  Simple queries, schema traversal (traverse.ts),        │ │
│  │  subscriptions, point-in-time, classification           │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Sections

| Section | File | Content |
|---------|------|---------|
| 1 | [01-data-model.md](./01-data-model.md) | Entities, Facts (set/patch/delete), References, Blobs, Metadata, Patches, Snapshots, Type System, System Entities, Common Types |
| 2 | [02-storage.md](./02-storage.md) | SQLite schema, tables, indices, patch storage, read path, snapshot creation, branch storage, point-in-time reads, garbage collection |
| 3 | [03-commit-model.md](./03-commit-model.md) | Operations, Transactions, Confirmed/Pending state, Validation rule, Stacked commits, Conflict handling |
| 4 | [04-protocol.md](./04-protocol.md) | WebSocket/HTTP transports, Message format, Commands (transact/query/subscribe/graph.query/branch), UCAN auth, Client API |
| 5 | [05-queries.md](./05-queries.md) | Simple queries, Schema traversal, Cycle detection, Subscriptions, Point-in-time, Classification/redaction, Entity references, Reactivity boundaries |
| 6 | [06-branching.md](./06-branching.md) | Branch lifecycle, Isolation, Merging, Conflict resolution, Point-in-time on branches, Branch diff, Depth limits |

## Implementation Materials

| File | Content |
|------|---------|
| [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md) | Build order, testing strategy, common pitfalls, spec gap tracking |
| [LEARNINGS.md](./LEARNINGS.md) | 20 lessons learned during v1 → v2 migration |
| [ARCHITECTURE-DIFF.md](./ARCHITECTURE-DIFF.md) | Key architectural differences between v1 and v2 |

## Key Type Summary

```typescript
// Entity identifier
type EntityId = `${string}:${string}`;

// Content-addressed reference (SHA-256, base32-lower)
type Reference = string & { readonly __brand: unique symbol };

// Facts — state transitions
interface SetWrite  { type: "set";    id: EntityId; value: JSONValue;  parent: Reference; }
interface PatchWrite { type: "patch";  id: EntityId; ops: PatchOp[];   parent: Reference; }
interface Delete    { type: "delete"; id: EntityId;                    parent: Reference; }
type Fact = SetWrite | PatchWrite | Delete;

// Operations in transactions
interface SetOperation        { op: "set";    id: EntityId; value: JSONValue;   parent: Reference; }
interface PatchWriteOperation { op: "patch";  id: EntityId; patches: PatchOp[]; parent: Reference; }
interface DeleteOperation     { op: "delete"; id: EntityId;                     parent: Reference; }
interface ClaimOperation      { op: "claim";  id: EntityId;                     parent: Reference; }
type Operation = SetOperation | PatchWriteOperation | DeleteOperation | ClaimOperation;

// Transaction
interface Transaction {
  operations: Operation[];
  codeCID?: Reference;
  branch?: string;
}

// Client commit with two-tier reads
interface ClientCommit {
  reads: {
    confirmed: ConfirmedRead[];  // Server-acknowledged reads
    pending: PendingRead[];       // Reads from unconfirmed commits
  };
  operations: Operation[];
  codeCID?: Reference;
  branch?: string;
}

// Validation rule (replaces strict CAS):
//   For each entity read: read.version >= server.head[entity].version
```

## System Entity Conventions

With the removal of the `the` dimension, system-level data (ACLs, schemas,
labels) is stored as regular entities with well-known ID conventions:

| Entity Type | ID Pattern | Example |
|-------------|------------|---------|
| Access Control List | `urn:acl:<space-did>` | `urn:acl:did:key:z6Mk...` |
| Schema | `urn:schema:<name>` | `urn:schema:contact` |
| Labels | `urn:label:<entity-id>` | `urn:label:urn:entity:abc` |
| Blob Metadata | `urn:blob-meta:<hash>` | `urn:blob-meta:bafk...` |

These are regular entities — they benefit from versioning, causal chains,
conflict detection, and branch isolation. No special storage dimension is
needed. See §01 Data Model, section 9 for details.
