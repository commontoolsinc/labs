# Query-Based Subscriptions

This system provides **incremental, link-aware, schema-driven queries** over a
graph of JSON documents, without re-running every query on every change. It's
built around three core ideas:

1. **Compile JSON Schema to a small IR** that behaves like a tree/graph
   automaton
2. **Evaluate on demand with memoization** and record fine-grained _provenance_
   (exact doc links that were inspected/followed)
3. **Incrementally maintain a dependency graph** from _doc links → IR states →
   query subscriptions_, so a doc change only rechecks the minimal affected
   subgraph

## Query Semantics

- **Query = (spaceDid, docId, path, schema, maxLinkDepth)**
- **Query evaluation context**: Queries operate on the `value` field of
  documents by default
  - When `path` is `[]` or omitted, the query evaluates against `doc.value`
  - When `path` is `["some", "path"]`, the query evaluates against
    `doc.value.some.path` (links can only point to the value part of documents)
- Documents can contain **links** with exact shape:

  ```json
  {
    "/": {
      "link@1": {
        "id": "<docId>",
        "path": ["users", "123", "profile"],
        "space": "did:key:..."
      }
    }
  }
  ```

  - `path` is an array of strings
  - `id` is optional; if omitted, link is within the same document
  - `space` is optional; if omitted, link is within the same space
  - When evaluating queries, links to other spaces are not followed and assumed
    to match
- **Source document synchronization**: When a document with a `source` field is
  included in query results:
  - The referenced source document should be synced to the client
  - This applies recursively for source documents that also have `source` fields
  - Links within source documents are not automatically followed during sync
- **Depth bound**: `maxLinkDepth` caps total link dereferences per evaluation;
  cycles allowed but cut off at budget
- **Schema truthiness**:
  - `true`: match anything; **follow links** on any value that is a link
    (subject to depth)
  - `false`: match nothing, **but root doc is still "touched"** (client should
    refresh that doc)
- **additionalProperties (AP)**:
  - **Omitted**: treat as "ignore non-listed properties" - do not inspect any
    property except those explicitly listed
  - **`false`**: same effect as omitted
  - **`true|schema`**: inspect non-listed properties; for `schema`, they must
    satisfy that schema
- **Combinators**:
  - `allOf`: value matches if **all branches** match
  - `anyOf`: value matches if **at least one branch** matches (handles parallel
    speculative branches)
- **Result semantics**: server maintains per subscription a **Touch Set** =
  exact set of `(docId, path)` links that were read, where `path` is an array of
  strings

## WebSocket API (v2)

Single endpoint per space: /api/storage/new/v2/:space/ws

- Client → Server
  - UCAN-wrapped invocations for commands:
    - /storage/hello { clientId, sinceEpoch }
    - /storage/get { consumerId, query } // one-shot; no server state kept
    - /storage/subscribe { consumerId, query } // register in-memory only
    - /storage/tx { ... }
  - ack { type: "ack", streamId: DID, epoch: number }
- Server → Client
  - deliver { type: "deliver", streamId: DID, epoch: number, docs: Array<{
    docId, branch?: string, version: { epoch: number, branch?: string }, kind:
    "snapshot"|"delta", body: unknown }> }
  - task/return complete tied to job: { the: "task/return", of: jobId, is: {
    type: "complete", at: { epoch, heads?, seq? }, streamId, filterId } }

At-least-once delivery: deliveries are grouped by global tx epoch. The server
does not persist per-delivery payloads. Instead, it persists a compact
"client-known" map of the last epoch per document per client (see Schema).

Resume: on connect the client calls /storage/hello with { sinceEpoch }. The
server conservatively redelivers snapshots when the client's sinceEpoch is
behind the server's persisted client-known epoch for a document.

Ordering: all documents bundled in a deliver frame share the same epoch. Acks
confirm receipt of all docs in that epoch for that connection.

### Client → Server (illustrative legacy-style frames)

```jsonc
{ "op": "hello", "protocol": "v2", "clientId": "xyz", "sinceEpoch": 123 }

{ "op": "subscribe", "queryId": "uuid", "spaceDid": "did:key:...",
  "docId": "doc:<ref>", "path": ["users"], "schema": {...}, "maxLinkDepth": 3 }

{ "op": "unsubscribe", "queryId": "uuid" }

{ "op": "ack", "epoch": 12345 }
```

### Server → Client

```jsonc
{ "op": "hello", "serverId": "…" }

{ "op": "subscribed", "queryId": "uuid", "catchingUp": true }

{ "op": "query-update", "queryId": "uuid", "epoch": 12345, "txHash": "<hex>", 
  "reason": "root-verdict-changed" | "touch-set-expanded" | "touch-set-shrunk" | "touched-doc-updated",
  "docsToRefresh": ["doc:<ref1>", "doc:<ref2>"],
  "sourceDocsToSync": ["doc:<ref3>", "doc:<ref4>"],
  "summary": { "oldVerdict": "Yes", "newVerdict": "No", 
               "deltaTouched": {"added": [], "removed": []} } }

{ "op": "idle", "queryId": "uuid" }

{ "op": "error", "code": "QueryError", "details": { /* ... */ } }
```

## Subscription Management

- **Subscribe**: compile schema to IR, evaluate once, compute Touch Set, and
  register reverse indexes in memory for this WS session. No DB rows are stored
  for subscriptions.
- **Get**: same as Subscribe but the server sends initial deliveries and a
  complete message, then discards the query state immediately.
- **Initial backfill**: when (get|subscribe) arrives, evaluate the query and
  compute the set of docs it refers to. For each doc, consult the in-memory
  "already sent on this socket" set and the persisted client-known table. If the
  client is missing the doc (or conservatively behind), send the current
  snapshot in a single deliver frame for the current epoch. Then send complete.
- **Ack model**: client acks with the epoch number; the server updates the
  client-known table for all docs included in that epoch for this connection and
  clears its in-memory map of pending docs for that epoch.
- **Change processing**: after each tx, use the provenance graph to determine
  which queries may be affected. Re-evaluate incrementally and produce the set
  of docs per client that require updates. Batch those into a single deliver
  frame per epoch per client.
- **Backpressure**: if socket bufferedAmount is high, coalesce updates but keep
  epoch grouping.
