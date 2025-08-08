# API Surface

All endpoints are **scoped by `:spaceDid`**.

## Documents & Branches

### POST `/v1/:space/docs` — Create a doc (and optional initial branch)

```json
{ "docId": "doc:<mh>", "branch": "main" }
```

Creates the doc entry and the branch if they don't exist.

### POST `/v1/:space/branches` — Create branch from a point

```json
{
  "docId": "doc:<mh>",
  "name": "feature-x",
  "from": { "branch": "main", "heads": ["h1","h2"] }
}
```

Also supports `{ "epoch": 12093 }` or `{ "at": "2025-08-01T..." }` for historical branch points.

### POST `/v1/:space/branches/:branchId/close` — Close branch (after merge)

```json
{ "mergedInto": { "branch": "main", "heads": ["h3"] } }
```

### GET `/v1/:space/heads/:docId?branch=main` — Current heads (and epoch)

Returns:

```json
{
  "docId": "...",
  "branch": "...",
  "heads": ["..."],
  "seq_no": 123,
  "epoch": 456,
  "root_ref": "mr:<...>"
}
```

### GET `/v1/:space/docs/:docId` — Retrieve a doc

Query params:

* `branch=main` (default)
* Point-in-time: `epoch=<id>` or `at=<timestamp>`
* Optional projection: `paths=a/b,c/d`
* `Accept: application/automerge` → raw Automerge binary; default is JSON.

## Transactions

### POST `/v1/:space/tx` — Submit a multi-doc transaction

**Request:**

```json
{
  "clientTxId": "uuid-from-client",
  "ucan": "<compact-ucan-jwt>",
  "reads": [
    { "docId": "doc:<mh>", "branch": "main", "heads": ["h1","h2"] }
  ],
  "writes": [
    {
      "docId": "doc:<mh>",
      "branch": "main",
      "baseHeads": ["h1","h2"],
      "changes": ["base64Change1", "base64Change2"],     
      "mergeOf": [
        { "branch": "feature-x", "heads": ["hx1","hx2"] }
      ]
    }
  ],
  "invariants": [
    { "type": "ifcPolicy", "params": { /* opaque */ } }
  ],
  "options": { "returnPatches": false, "returnHeads": true }
}
```

**Response:**

```json
{
  "txId": 12345,
  "committedAt": "2025-08-08T17:22:51.123Z",
  "txHash": "<hex>",
  "prevTxHash": "<hex>",
  "txBodyHash": "<hex>",
  "serverSig": "<b64>",
  "serverPubKey": "<b64>",
  "clientPubKey": "<b64>",
  "results": [
    { "docId": "...", "branch": "...", "status": "ok", "newHeads": ["h3"], "applied": 2 }
  ],
  "rejections": [],
  "conflicts": []
}
```

### GET `/v1/:space/tx/:txId` — Fetch receipt/summary

Returns crypto envelope plus CBOR-encoded TxBody for audit or replication.

## Immutable Blobs

* **PUT `/v1/:space/cid/:cid`** — body = raw bytes; returns `409` if the computed BLAKE3 CID doesn't match.
* **GET `/v1/:space/cid/:cid`** — returns blob bytes.

## WebSocket `/v1/:space/ws`

Text frames (JSON) multiplexed across docs.

**Client → Server:**

```jsonc
{ "op": "hello", "protocol": "v1", "clientId": "xyz" }

{ "op": "subscribe", "docId": "doc:<mh>", "branch": "main", "fromEpoch": 12000 }
{ "op": "unsubscribe", "docId": "doc:<mh>", "branch": "main" }

{ "op": "ack", "docId": "doc:<mh>", "branch": "main", "epoch": 12345 }

// Optional: direct AM Sync messages
{ "op": "sync", "docId": "doc:<mh>", "branch": "main", "message": "base64SyncMsg" }
```

**Server → Client:**

```jsonc
{ "op": "hello", "serverId": "…" }

{ "op": "subscribed", "docId": "doc:<mh>", "branch": "main", "catchingUp": true }

{ "op": "changes", "docId": "doc:<mh>", "branch": "main",
  "epoch": 12345, "txHash": "<hex>", "serverSig": "<b64>", "committedAt": "…",
  "changes": ["base64Change1","base64Change2"],
  "newHeads": ["h3"]
}

{ "op": "idle", "docId": "doc:<mh>", "branch": "main" }

{ "op": "error", "code": "ReadConflict", "details": { /* ... */ } }
```
