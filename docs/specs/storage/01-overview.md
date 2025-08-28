# High-Level Architecture

## Core Components

- **Runtime:** Deno 2
- **Web framework:** Hono (HTTP + WS)
- **DB:** SQLite via `npm:better-sqlite3` (fast, sync).

  - **One database per space** (see §1.1).
  - Fallback: `npm:sqlite3` if async I/O is required.
- **Automerge libs on server:** `npm:@automerge/automerge` (or compatible) for
  validating/deriving heads and optionally computing snapshots.

  - Avoid full doc materialization when possible — accept/apply changes by
    hash+deps.
  - Materialize only for invariants or snapshot creation.
- **Concurrency model:** Single writer per space DB, many readers; **WAL** mode
  with tuned pragmas.
- **Change storage model:** **Content-addressed**, append-only per
  `(doc, branch)`.

  - Raw change bytes stored **once** in a CAS table.
  - Per-branch sequence order stored separately.
  - Periodic **snapshots** and **incremental chunks** accelerate reads.
  - Heads maintained explicitly.
- **Transactions:** Optimistic concurrency using **heads** (or per-doc epoch) in
  client read set. Server:

  - Validates read assumptions
  - Runs declared invariants
  - Appends all changes atomically for all docs in the tx
  - Assigns a **global epoch** (`tx_id`)
  - Stamps with a `committed_at` timestamp
  - Extends a **BLAKE3-based, Ed25519-signed transaction chain** (see §4)
- **Subscriptions:** WebSocket multiplexed channels; clients subscribe to
  `(doc, branch)` and receive change notifications with **at-least-once**
  delivery and client acks by `tx_id`.

## Spaces

The system supports multiple independent **spaces**:

- Each space identified by a **space DID**: `did:key:...`.
- Spaces are **fully isolated** — docs, branches, transactions, and changes
  stored in a dedicated SQLite DB file.
- Authorization: only the space's DID or UCAN-delegated identities can act
  within the space.
- **Bootstrap:**

  - First tx in a space should be a _delegation doc_:

    - Doc URI: `doc:${BLAKE3({delegation: spaceDID})}` (multihash, base58btc)
    - Content: `{ "delegation": "<space DID>" }`
    - Written by client in tx #1.

## Document URIs

Two URI types:

- **Automerge docs:** `doc:<multihash-blake3>[/optional_path]`

  - CRDT docs with branches, changes, and snapshots.
  - Optional path for sub-resource addressing or ordering.
- **Immutable blobs:** `cid:<multihash-blake3>`

  - Immutable, content-addressed bytes — no branches/change history.

## Document Structure

**Automerge documents (`doc:`) have a standardized internal structure:**

- All documents are **objects at the root level**
- **Required field:** `value` - contains the current document value
  - If `value` is omitted, the current value is `undefined`
- **Metadata field:** `source` - optional link to a source document
  - When present, references another document that this document is derived from
  - Format:
    `{ "id": "<docId>", "path": ["optional", "path"], "space": "did:key:..." }`
  - `path` is optional; if omitted, references the root of the source document
  - `space` is optional; if omitted, references a document in the same space

**Example document structure:**

```json
{
  "value": {
    "title": "My Document",
    "content": "Hello world"
  },
  "source": {
    "id": "doc:QmSource...",
    "path": ["drafts", "v2"],
    "space": "did:key:..."
  }
}
```

**Source document synchronization:**

- When a document with a `source` field is synced to a client, the referenced
  source document should also be synced
- This applies recursively: if the source document also has a `source` field,
  that document should be synced as well
- Links within source documents are not automatically followed during this
  recursive sync process
