# Storage WS v2 Protocol

This document defines the Storage WS v2 protocol. It adopts UCAN-wrapped
invocations and receipt framing for commands, while server-driven updates are
untied Deliver frames. Initial snapshot completion is signaled by a task/return
"complete" tied to the invoking job.

## Endpoint

`/api/storage/new/v2/:space/ws`

## Client → Server

- UCAN-wrapped invocations for commands:
  - `/storage/get` { consumerId, query }
  - `/storage/subscribe` { consumerId, query }
  - `/storage/tx` { reads, writes, ... }
- Ack checkpoint:
  - `{ type: "ack", streamId: DID, deliveryNo: number }`

## Server → Client

- Deliver (untied to any job):
  ```json
  {
    "type": "deliver",
    "streamId": "did:key:...",
    "filterId": "123",
    "deliveryNo": 42,
    "payload": {/* change */}
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

- At-least-once delivery; clients dedupe by `deliveryNo`.
- Ordering: strictly increasing `deliveryNo` per `(streamId, filterId)`.
- Resume: server persists last acked `deliveryNo`; upon reconnect, resume from
  last ack.
- Backpressure: server monitors socket bufferedAmount and batches sends.

## Authorization

- Enforce UCAN capabilities at WS upgrade or first invocation.
- Reads require `storage/read` on `with: space:<did>`.
- Mutations require per-tx signature over canonical tx body and a delegation
  chain proving `storage/write`.
