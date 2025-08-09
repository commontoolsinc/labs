# API Surface (WebSocket only)

All interactions are scoped by `:spaceDid`. The API is provided exclusively over a single WebSocket endpoint. REST/HTTP endpoints are out of scope for the initial cut and may be added later if needed.

## WebSocket `/v1/:space/ws`

Text frames (JSON) multiplexed across docs and queries.

### Client → Server frames

```jsonc
{ "op": "hello", "protocol": "v1", "clientId": "xyz" }

// Subscribe to a document branch. If fromEpoch is omitted, starts from current heads.
{ "op": "subscribe", "docId": "doc:<ref>", "branch": "main", "fromEpoch": 12000 }

// Unsubscribe from a document branch
{ "op": "unsubscribe", "docId": "doc:<ref>", "branch": "main" }

// Submit a multi-doc transaction (base64 encoded Automerge changes)
{ "op": "tx",
  "clientTxId": "uuid-from-client",
  "ucan": "<compact-ucan-jwt>",
  "reads": [ { "docId": "doc:<ref>", "branch": "main", "heads": ["h1","h2"] } ],
  "writes": [
    { "docId": "doc:<ref>", "branch": "main", "baseHeads": ["h1","h2"],
      "changes": ["base64Change1", "base64Change2"],
      "mergeOf": [ { "branch": "feature-x", "heads": ["hx1","hx2"] } ]
    }
  ],
  "invariants": [ { "type": "ifcPolicy", "params": {} } ],
  "options": { "returnPatches": false, "returnHeads": true }
}

// Acknowledge up to an epoch (at-least-once delivery)
{ "op": "ack", "docId": "doc:<ref>", "branch": "main", "epoch": 12345 }

// Optional: direct Automerge sync messages
{ "op": "sync", "docId": "doc:<ref>", "branch": "main", "message": "base64SyncMsg" }
```

### Server → Client frames

```jsonc
{ "op": "hello", "serverId": "…" }

{ "op": "subscribed", "docId": "doc:<ref>", "branch": "main", "catchingUp": true }

{ "op": "changes", "docId": "doc:<ref>", "branch": "main",
  "epoch": 12345, "txHash": "<hex>", "serverSig": "<b64>", "committedAt": "…",
  "changes": ["base64Change1","base64Change2"],
  "newHeads": ["h3"]
}

{ "op": "tx-receipt",
  "clientTxId": "uuid-from-client",
  "txId": 12345,
  "results": [ { "docId": "...", "branch": "...", "status": "ok", "newHeads": ["h3"], "applied": 2 } ],
  "conflicts": [],
  "rejections": []
}

{ "op": "idle", "docId": "doc:<ref>", "branch": "main" }

{ "op": "error", "code": "ReadConflict", "details": { } }
```

Notes:
- All document creation and branch management occur implicitly via transactions. A client can create a doc and branch by submitting a write with an empty read set; the server ensures records exist.
- Retrieval of doc bytes occurs via subscription + changes stream, or via an optional future RPC if needed. Initial cut defers a standalone “GET doc” to keep scope minimal.
