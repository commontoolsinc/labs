# Spike: websocket compression for the memory v2 transport

Branch `spike/ws-compression`, based on main @ `f4faf22f1`. Status: **spike**
— measured and reviewed, not productionized. Do not merge as-is; see the
hardening list at the bottom.

## What it is

Per-message raw-deflate (RFC 1951) compression of memory v2 websocket
payloads, negotiated per connection via the websocket subprotocol
`fvj1.deflate`. Compressed payloads ride binary frames; payloads under 192
UTF-8 bytes stay text; non-negotiated connections are byte-identical to
before. The memory protocol itself (hello flags, message shapes, ordering
semantics) is untouched — the layer sits strictly below
`encodeMemoryBoundary`.

This substitutes for permessage-deflate, which `Deno.upgradeWebSocket` does
not negotiate (verified: the browser offers it, toolshed's 101 response omits
`sec-websocket-extensions`).

Files:

- `packages/memory/v2/transport-deflate.ts` — codec, subprotocol constant,
  threshold, inflate cap, `SerialTaskQueue` (new)
- `packages/toolshed/routes/storage/memory/memory.handlers.ts` — negotiation
  at upgrade, ordered inbound inflate, ordered outbound deflate
- `packages/toolshed/routes/storage/memory/memory-ws-deflate-stats.ts` —
  env-gated per-connection byte accounting (diagnostic, new)
- `packages/memory/v2/standalone.ts` — same support for the harness server
- `packages/runner/src/storage/v2-remote-session.ts` — client offer, ordered
  send/receive hops
- Tests: `packages/memory/test/v2-transport-deflate-test.ts`,
  `packages/toolshed/routes/storage/memory/memory-ws-deflate.test.ts`,
  `packages/runner/test/memory-v2-ws-deflate.test.ts`
- Flag registered in `docs/development/EXPERIMENTAL_OPTIONS.md`
  (`memoryWsDeflate`).

## Measured results (Lunch Poll two-browser flow, 2026-07-16)

Same-run paired accounting: logical = UTF-8 bytes of the uncompressed text
payload (identical to the metric PR #4712 uses), wire = bytes actually sent.

| Run | Result | Scenario wall | Bytes |
| --- | --- | ---: | --- |
| main baseline (unmodified) | PASS | 2,760 ms | — |
| spike, deflate on | PASS | 3,019 ms | browser: 3,960,389 → 837,854 B (**−78.8%**); all conns: 9,090,619 → 1,583,657 B (**−82.6%**) |
| spike, `CF_MEMORY_WS_DEFLATE=0` | PASS | 3,114 ms | server outbound wire == logical exactly; browsers still negotiate |
| spike, post-review fixes | PASS | — | browser −78.5%, all conns −81.7% (consistent re-measurement) |

Browser detail (deflate on): inbound 1,188,630 → 369,316 B (−68.9%),
outbound 2,771,759 → 468,538 B (−83.1%). Frame counts unchanged — no added
round trips, no retry protocol. Wall times are localhost and within run
noise; the win is bandwidth, not latency, at this scale. Time spent inside
compression hops totaled ~1.7 s across all 12 connections per run
(wall-in-hop, overstates pure CPU under event-loop contention; a
microbenchmark of the codec is ~0.06 ms per 5 KB message).

For calibration against the schema-machinery approach measured on PR #4712
(same flow, same metric): frame-local schema interning + durable request
schema CAS achieves −14.6% to −20.1%; this spike achieves −78.8% on browser
connections with roughly 250 lines of transport code and no protocol-level
state. Note main already includes #4292's frame-local sync-schema interning,
so the −78.8% is measured on top of already-interned payloads.

## Design notes

- **Negotiation**: websocket subprotocol, not a hello flag — the transport
  layer never parses memory messages, and the first frame can already be
  compressed. RFC 6455 §4.1 means a client that offers and is refused fails
  the connection (verified empirically: a server that refuses breaks the
  browser flow), therefore:
  - servers ALWAYS select the subprotocol when offered;
  - `CF_MEMORY_WS_DEFLATE=0` only stops a process from *spending*: Deno
    clients stop offering, servers stop compressing outbound. Inbound
    decompression stays unconditional.
  - **Rollout order**: server support must deploy before clients offer.
- **Ordering**: websocket delivery is ordered but deflate/inflate are async;
  each direction of each connection funnels through a `SerialTaskQueue`.
  Order is fixed at enqueue time, and the CLOSE notification queues behind
  pending inflates so every frame that arrived before a close is delivered
  before the close is signaled — the exact contract of the synchronous
  pre-spike path. (An adversarial review round found and we fixed: stale
  frames after close on the client, dropped pre-close frames on the server,
  and a swallowed error in the server's settle→handoff window.) Covered by
  unit tests on both ends.
- **Capability probe**: clients offer the subprotocol only if the runtime can
  construct `deflate-raw` streams (pre-2023 browsers would otherwise
  negotiate and then brick in a reconnect loop).
- **Close codes**: 1003 wrong frame type, 1007 undecodable compressed data,
  1009 inflate backlog exceeded, 1011 other.
- **Statelessness**: no shared sliding window (unlike permessage-deflate
  context takeover), so reconnects and replays need no transport state, and
  a corrupted frame cannot poison later frames. Context takeover would buy
  roughly a further 8 points (measured offline: −89% vs −81%) at the cost of
  per-connection window state; not worth it for a first pass.
- **Zip-bomb guard**: streaming inflate with a 64 MiB cap per frame; the
  server's 1 MiB pre-handshake negotiation buffer counts inflated bytes.

## Hardening before productionizing

1. Sync zlib (`node:zlib` `deflateRawSync`) or a pooled compressor on the
   server instead of per-message `CompressionStream` — cuts stream-setup
   overhead and the wall-in-hop cost.
2. Decide browser-client failure UX for old servers (currently: connection
   fails, reconnect loops). Requires server-first rollout, or an
   offer-then-fallback dial in the client.
3. Threshold (192 B), inflate cap (64 MiB), and inbound backlog bound
   (16 MiB, server-side) were chosen by eyeball; tune with the stats
   diagnostic. The client side has no backlog bound (it trusts the server).
4. The stats recorder writes synchronously on connection close and its flush
   can slightly undercount frames still in the inflate queue at close; fine
   as a dev diagnostic, keep it env-gated or remove before merge.
5. No end-to-end test drives `WebSocketTransport` against a server in pure
   text mode (all real-socket pairings in-repo now negotiate); covered at
   the unit level only.

## Reproducing the measurements

```bash
# byte accounting (server side, per closed connection):
CF_MEMORY_WS_DEFLATE_STATS_FILE=/tmp/ws-deflate-stats.jsonl \
  deno task integration patterns lunch-poll-vote

# kill switch (server sends text, Deno clients do not offer):
CF_MEMORY_WS_DEFLATE=0 deno task integration patterns lunch-poll-vote
```

Unit suites: memory package (`deno task test`), toolshed
`routes/storage/memory/memory-ws-deflate.test.ts`, runner
`test/memory-v2-ws-deflate.test.ts`.
