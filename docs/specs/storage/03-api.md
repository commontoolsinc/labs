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

## Client responsibilities (genesis)

To ensure concurrent creators of the same logical document converge, clients
MUST:

- Initialize new documents from a deterministic "genesis" head derived from the
  document id.
- Always send non-empty `baseHeads` for writes, including the first write on a
  brand-new document. For new documents, `baseHeads` MUST equal
  `[genesisHead(docId)]`.
- A reference implementation is provided as a helper that:
  - Creates an Automerge doc with the actor id set to the `docId` string.
  - Applies a single initial empty change to produce a deterministic head.
  - Immediately returns a `.fork()` of that doc (optionally with a provided
    actor id) for subsequent edits.

If a client’s first change does not depend on `genesisHead(docId)`, the server
will reject the transaction with `conflict: incorrect genesis`.
