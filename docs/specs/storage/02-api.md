# API

All routes are **scoped by space**:

Base: `/v1/:spaceDid/...`

> 401/403 if the caller cannot act within `:spaceDid` (UCAN denies).

## Create Document

POST `/v1/:space/docs`

```json
{ "docId": "doc:<hash>", "branch": "main" }
```

- Creates doc and branch if absent.
- Returns `{ docId, branch, branchId }`.

## Create Branch

POST `/v1/:space/branches`

```json
{
  "docId": "doc:<hash>",
  "name": "feature-x",
  "from": { "branch": "main", "heads": ["h1", "h2"] } // or { epoch } or { at }
}
```

## Heads

GET `/v1/:space/heads/:docId?branch=main`

- Returns `{ heads, seq_no, epoch, root_hash }`.

## Get Document (snapshot)

GET `/v1/:space/docs/:docId?branch=main&epoch=123|at=ISO`

- `Accept: application/automerge` → returns binary AM file (snapshot+chunks
  concat).
- Default JSON → materialize and serialize `toJS()`.

## Submit Transaction (multi-doc)

POST `/v1/:space/tx`

```jsonc
{
  "clientTxId": "uuid",
  "ucan": "<compact-jwt>",
  "reads": [{ "docId": "doc:...", "branch": "main", "heads": ["h1", "h2"] }],
  "writes": [{
    "docId": "doc:...",
    "branch": "main",
    "baseHeads": ["h1", "h2"], // actual heads for server checks
    "changes": ["base64", "..."] // raw AM change bytes, ordered
  }],
  "options": { "returnHeads": true }
}
```

## Response

```json
{
  "txId": 123,
  "committedAt": "...",
  "txHash": "<hex>",
  "prevTxHash": "<hex>",
  "txBodyHash": "<hex>",
  "serverSig": "<base64>",
  "serverPubKey": "<base64>",
  "clientPubKey": "<base64>",
  "results": [{ "docId":"...", "branch":"...", "status":"ok", "newHeads":["..."], "applied":N }],
  "rejections": []
}
```

## Tx Receipt

GET `/v1/:space/tx/:txId`

- Returns cryptographic envelope and CBOR `TxBody` (base64).

## Immutable CIDs

PUT `/v1/:space/cid/:cid` (body = bytes)

- Creates content-addressed blob. 409 if `cid` mismatch.

GET `/v1/:space/cid/:cid`

- Returns bytes.

## WebSocket

WS `/v1/:space/ws`

Client → Server

```jsonc
{ "op":"hello", "protocol":"v1", "clientId":"..." }
{ "op":"subscribe", "docId":"doc:...", "branch":"main", "fromEpoch": 12000 }
{ "op":"ack", "docId":"doc:...", "branch":"main", "epoch": 12345 }
```

Server → Client

```jsonc
{ "op":"hello", "serverId":"..." }
{ "op":"subscribed", "docId":"...", "branch":"...", "catchingUp": true }
{ "op":"changes",
  "docId":"...", "branch":"...",
  "epoch":12345, "txHash":"<hex>", "serverSig":"<b64>",
  "committedAt":"...",
  "changes":["b64","..."], "newHeads":["..."]
}
```
