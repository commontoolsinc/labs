# Storage WS v2 Protocol

This document defines the Storage WS v2 protocol. It adopts UCAN-wrapped
invocations and receipt framing for commands, while server-driven updates are
untied Deliver frames. Initial snapshot completion is signaled by a task/return
"complete" tied to the invoking job.

## Endpoint

`/api/storage/new/v2/:space/ws`

## Client → Server

- UCAN-wrapped invocations for commands:
  - `/storage/hello` { clientId: string, sinceEpoch: number }
  - `/storage/get` { consumerId, query }
  - `/storage/subscribe` { consumerId, query }
  - `/storage/tx` { reads, writes, ... }
- Ack checkpoint:
  - `{ type: "ack", streamId: DID, epoch: number }`

## Server → Client

- Deliver (untied to any job, grouped by epoch):
  ```json
  {
    "type": "deliver",
    "streamId": "did:key:...",
    "epoch": 12345,
    "docs": [
      {
        "docId": "doc:...",
        "branch": "main",
        "version": { "epoch": 12345, "branch": "main" },
        "kind": "snapshot",
        "body": {/* JSON snapshot or delta */}
      }
    ]
  }
  ```
- Complete (task/return tied to the job):
  ```json
  {
    "the": "task/return",
    "of": "job:<hash>",
    "is": {
      "type": "complete",
      "at": { "seq": 123 },
      "streamId": "did:key:...",
      "filterId": "123"
    }
  }
  ```
- Tx result (task/return):
  ```json
  { "the": "task/return", "of": "job:<hash>", "is": {/* TxReceipt */} }
  ```

## Semantics

- At-least-once delivery; clients dedupe by `epoch` and doc ids.
- Ordering: all documents in a deliver share the same `epoch` (global tx id).
- Resume: server persists per-client per-document knowledge
  `{ clientId, docId,
  epoch }`. On reconnect, client provides `sinceEpoch`.
  The server will redeliver snapshots for any doc whose persisted epoch is
  greater than the client's `sinceEpoch`.
- Backpressure: server monitors socket bufferedAmount and batches sends per
  epoch; multiple epochs can be in-flight before acks.

## Authorization

- Enforce UCAN capabilities at WS upgrade or first invocation.
- Reads require `storage/read` on `with: space:<did>`.
- Mutations require per-tx signature over canonical tx body and a delegation
  chain proving `storage/write`.
