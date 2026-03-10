# Memory v2 Specification

A complete, clean-break redesign of the Memory system — the persistent,
transactional, content-addressed store that underlies the Common Tools runtime.

## Design Goals

1. **Clean break in storage semantics** — No backward compatibility with the v1
   database or internal storage model. During migration, high-level cutover
   interfaces may remain stable while the implementation underneath them is
   replaced.
2. **Boring nomenclature** — Replace the cute v1 terms (`the`, `of`, `since`,
   `cause`) with standard ones (`id`, `seq`, `parent`). Drop the `the` dimension
   entirely (it was always `application/json`).
3. **Incremental changes** — Transactions support patches (JSON Patch + splice
   extension), not just whole-document replacement. Patches are stored as-is and
   replayed on read, with periodic snapshots for efficiency.
4. **Content-addressed blobs** — Immutable, write-once binary data with mutable
   metadata stored separately from entities.
5. **Point-in-time retrieval** — Read any entity's state at any seq number on
   any branch.
6. **Branching** — Lightweight branches with isolation, merging, and conflict
   detection. Branches share the fact history (O(1) creation).
7. **Optimistic commit model** — Local commits are synchronous and optimistic.
   The server confirms asynchronously, with seq-based validation (replacing
   strict CAS). See §03 for the confirmed/pending model.
8. **Schema-based traversal** — Graph queries follow JSON Schema-defined
   references, reusing `traverse.ts` patterns (cycle detection, schema
   narrowing).

## Nomenclature

| v1 Term                | v2 Term                    | Description                                                                                                        |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `the`                  | _(dropped)_                | Was always `application/json`. No type dimension in v2.                                                            |
| `of`                   | `id`                       | Entity identifier (URI)                                                                                            |
| `since`                | `seq`                      | Monotonic sequence number (Lamport clock)                                                                          |
| `cause`                | `parent`                   | Reference to previous fact in causal chain                                                                         |
| `is`                   | `value`                    | The JSON data                                                                                                      |
| `Unclaimed`            | `Empty`                    | Genesis state before any writes                                                                                    |
| `Assertion`            | `Write` (`set` or `patch`) | A fact that sets/patches a value                                                                                   |
| `Retraction`           | `Delete`                   | Tombstone fact                                                                                                     |
| `Changes`              | `Operation[]`              | Flat list of typed operations                                                                                      |
| `Selection`            | `FactSet`                  | Query result set                                                                                                   |
| `Selector`             | `Query` / `Selector`       | Query pattern                                                                                                      |
| `datum` table          | `value` table              | Content-addressed JSON value storage                                                                               |
| `memory` table         | `head` table               | Current state pointer per entity per branch                                                                        |
| Heap                   | Confirmed                  | Server-acknowledged client state                                                                                   |
| Nursery                | Pending                    | Optimistic unconfirmed client state                                                                                |
| `IStorageSubscription` | `IStorageNotificationSink` | Scheduler notification interface (commit/integrate events). Renamed to avoid confusion with v2 data subscriptions. |
| `StorageSubscription`  | `StorageNotificationRelay` | Implementation class for scheduler notifications                                                                   |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Client                                │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Confirmed   │  │   Pending    │  │   Client Library   │  │
│  │  (seq,       │  │  (stacked    │  │  connect()         │  │
│  │   value)     │  │   commits,   │  │  session.transact()│  │
│  │              │  │   localSeq)  │  │  session.queryGraph│  │
│  │              │  │              │  │  (subscribe=true)  │  │
│  └──────────────┘  └──────────────┘  └─────────┬─────────┘  │
│                                                 │            │
└─────────────────────────────────────────────────┼────────────┘
                                                  │ WebSocket
┌─────────────────────────────────────────────────┼────────────┐
│                       Server                    │            │
│                                                 ▼            │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   Protocol Layer                        │ │
│  │  UCAN auth, routing, subscription management            │ │
│  └────────────────────────┬────────────────────────────────┘ │
│                           │                                  │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │                   Commit Engine                         │ │
│  │  Seq-based validation, atomic apply, conflict handling  │ │
│  └────────────────────────┬────────────────────────────────┘ │
│                           │                                  │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │                   Storage (SQLite)                      │ │
│  │  value | fact | head | commit | invocation              │ │
│  │  authorization | snapshot | branch                      │ │
│  │  blob_store                                             │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   Query Engine                          │ │
│  │  graph.query traversal, subscriptions, point-in-time    │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Sections

| Section | File                                       | Content                                                                                                                                             |
| ------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | [01-data-model.md](./01-data-model.md)     | Entities, Facts (set/patch/delete), References, Blobs, Metadata, Patches, Snapshots, Type System, System Entities, Common Types                     |
| 2       | [02-storage.md](./02-storage.md)           | SQLite schema, tables, indices, patch storage, read path, snapshot creation, branch storage, point-in-time reads, garbage collection                |
| 3       | [03-commit-model.md](./03-commit-model.md) | Operations, Transactions, Confirmed/Pending state, Validation rule, Stacked commits, Conflict handling                                              |
| 4       | [04-protocol.md](./04-protocol.md)         | WebSocket transport, Message format, Commands (transact/query.subscribe/graph.query/branch), UCAN auth, Client API                                  |
| 5       | [05-queries.md](./05-queries.md)           | Simple queries, Schema traversal, Cycle detection, Subscriptions, Point-in-time, Entity references, Reactivity boundaries (classification deferred in phase 1) |
| 6       | [06-branching.md](./06-branching.md)       | Branch lifecycle, Isolation, Merging, Conflict resolution, Point-in-time on branches, Branch diff, Depth limits                                     |

## Implementation Materials

| File                                                             | Content                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| [10-implementation-guidance.md](./10-implementation-guidance.md) | Architectural guidance, known pitfalls, phasing, and anti-patterns |

## Key Type Summary

```typescript
// Entity identifier (plain string — no format constraint enforced)
type EntityId = string;

// Content-addressed reference (SHA-256, base32-lower)
type Reference = string & { readonly __brand: unique symbol };

// Facts — state transitions
interface SetWrite {
   type: "set";
   id: EntityId;
   value: JSONValue;
   parent: Reference;
}
interface PatchWrite {
   type: "patch";
   id: EntityId;
   ops: PatchOp[];
   parent: Reference;
}
interface Delete {
   type: "delete";
   id: EntityId;
   parent: Reference;
}
type Fact = SetWrite | PatchWrite | Delete;

// Operations in transactions (parent-free on wire; server resolves parents)
interface SetOperation {
   op: "set";
   id: EntityId;
   value: JSONValue; // Root replacement; equivalent to replace at path []
}
interface PatchWriteOperation {
   op: "patch";
   id: EntityId;
   patches: PatchOp[];
}
interface DeleteOperation {
   op: "delete";
   id: EntityId;
   // Root delete; equivalent to remove at path []
}
type Operation =
   | SetOperation
   | PatchWriteOperation
   | DeleteOperation;

// Transaction
interface Transaction {
   operations: Operation[];
   codeCID?: Reference;
   branch?: string;
}

// Client commit with two-tier reads
type ReadPath = readonly string[]; // Relative to EntityDocument.value; [] = root
interface ConfirmedRead {
   id: EntityId;
   branch?: string; // Defaults to commit.branch; merge proposals set this explicitly
   path: ReadPath;
   seq: number;
}
interface PendingRead {
   id: EntityId;
   path: ReadPath;
   localSeq: number;
}
interface ClientCommit {
   localSeq: number;
   reads: {
      confirmed: ConfirmedRead[]; // Server-acknowledged reads
      pending: PendingRead[]; // Reads from unconfirmed commits
   };
   operations: Operation[];
   codeCID?: Reference;
   branch?: string;
   merge?: { sourceBranch: string; sourceSeq: number; baseBranch: string; baseSeq: number };
}

// Entity values are stored in an envelope (not bare JSON)
interface EntityDocument {
   value: JSONValue; // The cell's data. Delete is represented by Delete facts.
   source?: SourceLink; // {"/":"<short-id>"} resolves to of:<short-id>.
}
interface SourceLink {
   "/": string;
}

// Validation rule (replaces strict CAS):
//   For each read (id, path, seq), there must be no later overlapping write
//   on that entity/path on the target branch with seq > read.seq.
```

Successful write-class commands (`/memory/transact`, `/memory/branch/create`,
`/memory/branch/delete`) preserve two linked audit layers:

- the semantic write payload, hashed as `commit.hash`
- the authenticated UCAN transport envelope (`invocation` + `authorization`),
  persisted separately and referenced from the resulting commit record

This keeps commit identity stable across replay or re-authorization while
preserving signer/proof data needed for later audit and richer receipt designs.

**Two kinds of "subscription"**: The v2 protocol defines _data subscriptions_
(§04-05) — server-to-client streams of entity updates. Separately, the runner's
scheduler uses _storage notifications_ (`IStorageNotificationSink`) — local
callbacks that fire on commit/integrate events. These are distinct systems; the
rename from `IStorageSubscription` to `IStorageNotificationSink` makes this
explicit.

## System Entity Conventions

With the removal of the `the` dimension, system-level data (ACLs, schemas, blob
metadata) is stored as regular entities with well-known ID conventions:

| Entity Type         | ID Pattern              | Example                    |
| ------------------- | ----------------------- | -------------------------- |
| Access Control List | `<space-did>`           | `did:key:z6Mk...`          |
| Schema              | `urn:schema:<name>`     | `urn:schema:contact`       |
| Blob Metadata       | `urn:blob-meta:<hash>`  | `urn:blob-meta:bafk...`    |

These are regular entities — they benefit from versioning, causal chains,
conflict detection, and branch isolation. No special storage dimension is
needed. See §01 Data Model, section 9 for details.
