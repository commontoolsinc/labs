# API Surface (WebSocket only, v2)

All interactions are scoped by `:spaceDid`. The API is provided exclusively over
a single WebSocket endpoint. REST/HTTP endpoints are out of scope for the
initial cut and may be added later if needed.

## WebSocket `/v2/:space/ws`

Text frames (JSON). Commands are UCAN-wrapped invocations; server pushes untied
Deliver frames. HTTP routes are deprecated in favor of WS.

### Client → Server frames

- UCAN-wrapped invocations:
  - `/storage/get` { consumerId, query }
  - `/storage/subscribe` { consumerId, query }
  - `/storage/tx` { reads, writes (base64 changes), ... }
- Acknowledge (at-least-once, checkpoint):
  - `{ "type": "ack", "streamId": "did:key:...", "deliveryNo": 123 }`

### Server → Client frames

- Deliver (untied):
  - `{ "type": "deliver", "streamId": "did:key:...", "filterId": "123", "deliveryNo": 42, "payload": { ... } }`
- Complete (task/return tied to job):
  - `{ "the": "task/return", "of": "job:<hash>", "is": { "type": "complete", "at": {"seq": 123}, "streamId": "did:key:...", "filterId": "123" } }`
- Tx result (task/return):
  - `{ "the": "task/return", "of": "job:<hash>", "is": {/* TxReceipt */} }`

Notes:

- All document creation and branch management occur implicitly via transactions.
- Retrieval of doc bytes for point-in-time can use PIT endpoint or future WS
  command if needed; standard flow is get/subscribe + Deliver.
