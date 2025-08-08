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
  - When `path` is `/` or omitted, the query evaluates against `doc.value`
  - When `path` is `/some/path`, the query evaluates against
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

## WebSocket API

### Client → Server

```jsonc
{ "op": "hello", "protocol": "v1", "clientId": "xyz" }

{ "op": "subscribe", "queryId": "uuid", "spaceDid": "did:key:...", 
  "docId": "doc:<mh>", "path": "/users", "schema": {...}, "maxLinkDepth": 3 }

{ "op": "unsubscribe", "queryId": "uuid" }

{ "op": "ack", "queryId": "uuid", "epoch": 12345 }
```

### Server → Client

```jsonc
{ "op": "hello", "serverId": "…" }

{ "op": "subscribed", "queryId": "uuid", "catchingUp": true }

{ "op": "query-update", "queryId": "uuid", "epoch": 12345, "txHash": "<hex>", 
  "reason": "root-verdict-changed" | "touch-set-expanded" | "touch-set-shrunk" | "touched-doc-updated",
  "docsToRefresh": ["doc:<mh1>", "doc:<mh2>"],
  "sourceDocsToSync": ["doc:<mh3>", "doc:<mh4>"],
  "summary": { "oldVerdict": "Yes", "newVerdict": "No", 
               "deltaTouched": {"added": [], "removed": []} } }

{ "op": "idle", "queryId": "uuid" }

{ "op": "error", "code": "QueryError", "details": { /* ... */ } }
```

## Subscription Management

- **Subscribe**: compile schema to IR, evaluate once, compute Touch Set,
  register reverse indexes
- **Unsubscribe**: remove from reverse indexes, optionally GC unused IR nodes
- **Ack model**: client acks with highest `epoch` fully processed per query
- **Backpressure**: if unacked updates exceed threshold, server pauses sending
  to that subscription
