# Memory wire chunking

The memory v2 protocol delivers each server or client message as a single
WebSocket text frame. A sync response's size is proportional to the watched
document's graph closure, and nothing bounds it: the deployed topics board's
initial sync is one 93.7 MB message (7,967 upserts). Deno's WebSocket client
rejects any incoming message over 64 MiB with `Frame too large` and closes
the connection, so every Deno client — cf, fuse, services — hard-fails on
such a document, and retries cannot help. The client→server direction has
the same ceiling ahead of it: read-set commits on that board already reach
2.6 MB. Evidence and measurements:
[labs#6319](https://github.com/commontoolsinc/labs/issues/6319).

This plan splits oversized wire messages into bounded chunks below the
codec, negotiated as an optional protocol capability. It changes framing
only. It deliberately does not change what a sync delivers: the
`SessionSync` stays one logical frame, so the per-frame schema-closure
guarantee (OW61), arrival validation, and the speculation overlay are
untouched. Shrinking the payload itself is the separate work tracked in
labs#6319 (delivery-time schema dedup; closure narrowing).

## Wire contract

### Capability

A new optional capability `wireChunking` joins the memory protocol flags:

- Advertised in `hello` (client) and `hello.ok` (server). Build-inherent —
  a build that implements it always advertises it, like
  `sqliteCommitRowLabelEval`.
- Absent parses to `false` (`parseMemoryProtocolFlags`), so optional-
  capability consumers fail closed. Old peers ignore unknown flag keys.
- NOT added to `compatibleMemoryProtocolFlags` — only `modernCellRep` gates
  compatibility. Peers without the capability connect and converse exactly
  as today.
- A sender may chunk only toward a peer that advertised the capability: the
  server consults the client's `hello` flags; the client consults the
  existing `Client#serverFlags` getter (already fail-closed, already
  populated from `hello.ok`).
- The handshake itself is never chunked: `hello` and `hello.ok` are always
  single frames, in every build. Chunking applies only to messages after
  negotiation.

### Chunk frame

A chunked message is a sequence of text frames, each:

```text
fvc1:<streamId>:<index>:<count>:<slice>
```

- `fvc1:` is the envelope tag. An unchunked message always begins `fvj1:`,
  so a receiver dispatches on the prefix. Neither tag can appear at the
  start of the other's body.
- `streamId` is a decimal per-connection counter owned by the sender.
- `index` is 0-based decimal; `count` is the total (decimal, always ≥ 2 —
  a payload at or under the threshold is sent unchunked, and `count` of 1
  is a protocol error).
- `<slice>` is a substring of the encoded `fvj1:…` payload. Reassembly is
  concatenation of slices in index order; the result is byte-identical to
  the unchunked encoding and flows into the existing decode path
  (`decodeMemoryBoundary`). Consumers that substring-gate the raw payload
  (`containsReservedSchemaRefSubstring`, the client expansion gate) run on
  the reassembled string only, so the verbatim-embedding property they pin
  is unaffected.

**Slicing is by UTF-16 code units with surrogate-pair protection.** The
payload is a JS string and WebSocket text frames are UTF-8: a slice
boundary that lands between a high and low surrogate would produce an
unencodable frame. When the boundary character is a high surrogate, the
boundary moves back one code unit. Slice size is measured in code units
(no encoding pass); the byte length of a slice is at most 3× its code-unit
length, which the size constants account for.

### Ordering and errors

Chunks of one stream are sent contiguously: the sender emits no other frame
between `index` 0 and `index` `count − 1` of a stream. A receiver therefore
holds at most one in-flight stream per direction. Each of the following is
a protocol error, and the receiver closes the connection (the client
surfaces its normal `ConnectionError`/reconnect path; a server host closes
with code 1002):

- a malformed `fvc1:` header;
- an `index` that is not the expected next index of the open stream, or a
  first frame whose `index` is not 0;
- a `fvj1:` frame or a new stream arriving while a stream is open;
- a stream exceeding the reassembly cap.

A partially reassembled stream is discarded when the connection closes;
reconnect re-syncs from scratch, as today.

### Size constants

- Send threshold and slice size: 8 Mi code units (≤ 24 MiB UTF-8 worst
  case — comfortably under the 64 MiB cap, few frames per real payload).
  A payload over the threshold is split into slices of at most that size.
- Reassembly cap: 512 Mi code units (the known-real payload is ~94 M and
  grows with board content).
- Both are module constants beside the codec with one test-only setter
  (the `setOwnWriteEchoConfig` shape) so integration tests can force
  chunking with small payloads. The setter rejects a chunk size below two
  code units: at least two, the surrogate back-off always leaves a
  non-empty slice behind.

## Implementation map

New module `packages/memory/v2/wire-chunking.ts`:

- `WireChunker` — the sender-side per-connection object that owns the
  stream counter; one per connection, dropped on close.
- `splitWireMessage(encoded: string, chunker: WireChunker): string[]` —
  returns `[encoded]` untouched at or under the threshold, else the
  `fvc1:` frames numbered from the chunker's counter.
- `WireReassembler` — `accept(frame: string): string | null`; returns the
  completed payload (or the frame itself for `fvj1:` input with no open
  stream), `null` mid-stream; throws a typed protocol error on the
  violations above. Holds the per-direction state; one per connection per
  direction; dropped on close.

A connection therefore owns a pair: a `WireChunker` outbound and a
`WireReassembler` inbound, both created at connect and dropped at close.

Flag plumbing in `packages/memory/v2.ts`: `wireChunking` added to
`MemoryProtocolFlags`, `getMemoryProtocolFlags` (constant `true`, comment
in the build-inherent style), `parseMemoryProtocolFlags` (absent → false),
`wireMemoryProtocolFlags`. Not in `compatibleMemoryProtocolFlags`. Register
the flag row in `docs/development/EXPERIMENTAL_OPTIONS.md` (the flags block
in `v2.ts` points there; read that registry's own conventions first).

Server hosts — `Server.connect`'s callback contract (message values) is
deliberately unchanged; its test callers stay as they are. Each socket host
wraps both directions itself with the shared helpers:

- `packages/toolshed/routes/storage/memory/memory.handlers.ts`
  (`attachMemorySocketPipeline`): it already parses `firstMessage` — read
  the client's advertised `wireChunking` from that parsed `hello`. Outbound:
  the connect callback becomes encode → `splitWireMessage` when negotiated →
  `socket.send` per frame. Inbound: one `WireReassembler` in front of
  `connection.receive`, on both the `firstMessage` delivery and the
  post-handoff `onMessage` path (messages buffered by
  `bufferTextMessagesUntilNegotiated` replay in order through the same
  reassembler; a chunk as first message is impossible by the
  handshake-is-never-chunked rule, and the reassembler rejects it anyway).
- `packages/memory/v2/standalone.ts`: the same wrap on its socket handler.

Client — `packages/memory/v2/client.ts`:

- Inbound: the `WireReassembler` at the top of `onMessage`, before
  `decodeMemoryBoundary`; reset it in the transport-close path alongside
  the existing disconnect handling.
- Outbound: route the post-handshake send sites through one helper that
  encodes and splits when `this.serverFlags?.wireChunking` is true. The
  `hello` send stays direct (never chunked). `Transport.send` is unchanged
  (`send(payload: string)` per frame).

## Tests

New `packages/memory/test/v2-wire-chunking.test.ts` (follow
`docs/development/unit-test-coding-style.md`):

- Round-trips: below/at/above threshold, exact-multiple sizes, a payload
  whose slice boundary lands inside a surrogate pair (non-BMP content —
  the boundary must move and the round-trip stay byte-identical),
  `fvj1:` passthrough.
- Protocol errors: bad header, wrong first index, gap, duplicate, a
  `fvj1:` frame mid-stream, a second stream mid-stream, reassembly cap.

Integration, in the existing standalone-server test arrangement with the
test seam forcing a small threshold: a large response round-trips through
a real socket pair; a client whose `hello` omits the flag receives
unchunked frames; a client sending an over-threshold request chunks it and
the server reassembles. The verbatim-embedding pinning test
(`test/v2-sync-schema-table.test.ts`) and the full memory suite stay green.

## Verification against the outage

The gate: a local current-vintage toolshed over a space whose board sync
exceeds 64 MiB (synthesize by volume, or lower the Deno-side threshold is
not possible — the 64 MiB cap is the runtime's; synthesize the payload),
`cf get <board> topics --input` succeeds where it fails today with
`ConnectionError: Frame too large`. After deploy, the same read against
Estuary's real board returns rows (expect ~60–90 s of server assembly —
that latency is out of scope here, tracked in labs#6319).

## Rollout

Lands in labs main → loom-stable pin → Estuary dispatch. The shell deploys
in lockstep with the server, so both ends gain the capability together. An
older cf against a newer server negotiates nothing and behaves exactly as
today (including still failing on over-cap frames until upgraded); a newer
cf against an older server likewise.

## Stages

- [x] Chunk codec module + flag plumbing + unit tests
- [ ] Toolshed and standalone host wiring + client wiring + integration
      tests
- [ ] `EXPERIMENTAL_OPTIONS.md` registry row; full memory suite +
      `deno task check` green
- [ ] Local over-64 MiB verification; PR routed to the memory delivery
      owner for review
