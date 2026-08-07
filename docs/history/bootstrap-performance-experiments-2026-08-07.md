---
status: historical
created: 2026-08-07
archived: 2026-08-07
reason: "Experiment record: hello-world bootstrap baseline and four prototyped fixes, the evidence behind the CT-1963 proposals."
---

# Fresh-space bootstrap: findings and proposals

## The takeaway

Even the simplest pattern is slow for reasons that have nothing to do with the
pattern: deploying a 41-line hello world into a fresh space on Rapids takes
44.6 s, and a single handler call takes 8.5 s. We ran four controlled
experiments against a WAN-emulation testbed to find out why and what to do.
The answers: **62% of a deploy's download is the server echoing the client's
own uploads back in the transact reply** (fixable at the server response
boundary, roughly one line); **the Rapids-specific slowness is not commit
application** (~9 ms) **but seconds-long synchronous graph traversals
blocking the single-threaded event loop for every connected client**; **an
app-level compression flag cuts all wire traffic ~7× at no CPU cost** (native
WebSocket compression does not exist in Deno — verified); and **two
obvious-looking fixes are measured dead ends** (batching the cache publish,
and suppressing the echo client-side). Five proposals are ready in priority
order; five questions need owner rulings before the top two land.

## Findings at a glance

| Question | Answer | Evidence |
| --- | --- | --- |
| Why does a fresh-space deploy download ~1.6 MB after uploading ~1 MB? | The `transact` reply returns every uploaded document body verbatim; the client uses one integer of it (`applied.seq`). ~961 KB per deploy, 62% of the download. The watch system is innocent — it already suppresses self-echo. | Finding 1 |
| Is the server slow at applying the 645 KB bootstrap commit (~17 s gap on Rapids)? | No — apply is 8.6–10.6 ms in every configuration, including beside a 2.5 GB space. The gap is queueing: `session.watch.add` on a big space runs 1.8–2.0 s of synchronous traversal that blocks the whole event loop. | Finding 2 |
| Can the transport compress the (9–23× compressible) protocol traffic? | Not natively — Deno has no permessage-deflate on either side (verified empirically). A 174-line negotiated app-level flag works: 7.0× less upload, 7.7× less download, no measurable CPU cost. | Finding 3 |
| Would batching the chunked cache publish into one transaction help? | No. Measured zero net wall-time on a bandwidth-capped link (the publish is bytes-bound, not round-trip-bound), and the chunking is a deliberate crash-durability fix (#5094). Abandoned. | Finding 4 |
| Can the serial deploy preamble be overlapped? | Yes — running the home-space probe concurrently with the source fetch saves ~1.0 s (6.5%) with semantics preserved and new tests. | Finding 4 |

## What to do (proposals, ranked)

| # | Change | Size | Effect | Status |
| --- | --- | --- | --- | --- |
| P1 | Strip document bodies from the transact reply (server response boundary) | ~1 line + test | −961 KB per fresh-space deploy, deterministic | needs owner ruling (Q1) |
| P2 | `deflateFrames` app-level WS compression | 174 lines, prototyped + tested | 7× wire reduction both ways | ready for review; scrutinize the frame-ordering queue |
| P3 | Transact + queue-wait slow-query instrumentation | small, mostly written | turns the Rapids tail into a logged number | shippable now |
| P4 | Yield or bound `session.watch.add` traversal on large spaces | needs design (Q3) | removes multi-second event-loop stalls for every client | the Rapids-specific fix |
| P5 | Parallel deploy preamble (fetch mode) | small, prototyped + 3 tests | −1.0 s per fresh-space deploy; grows on real WAN | ready for review |
| P6 | HTTP `compress()` on toolshed | ~1 line + route checks | 4.6 MB shell bundle → ~1 MB; all HTTP routes | quick independent win |
| — | Single-transaction cache publish | — | zero net win; forfeits #5094 crash durability | **abandoned — do not revisit** |
| — | Client-side echo suppression | — | two variants measured: no effect / net worse | **abandoned — fix is P1** |

## Questions for the owners

1. **P1 gate.** The protocol spec reserves a post-apply `document` on *patch*
   revisions as the writer's channel for merge-rebased truth
   (`docs/specs/memory-v2/04-protocol.md:1001-1003`); it is not implemented.
   Is it planned? If yes, the verdict strip exempts patch revisions; if no,
   the strip is unconditional and the spec line should change in the same PR.
2. **Watches on immutable docs.** Content-addressed compile-cache entries
   never change under their key, yet cache reads register watches (there is
   no read-without-watch on the pull path, and no unwatch message exists —
   watch sets are append-only per session). Should cache reads move to
   one-shot `graph.query`, and/or should the protocol grow an unwatch or a
   "watch without initial sync at seq" form?
3. **P4 shape.** Is yielding inside `trackGraph` acceptable (re-entrancy and
   consistency assumptions during traversal), or is bounding the per-call
   batch the safer form?
4. **Bootstrap design (parked, but the floor).** Must each space durably
   carry its own copy of the identical compiled system pattern, uploaded by
   each client, or can genesis be server-seeded / globally content-addressed?
   What does CFC provenance require?
5. **Compression rollout.** Any objection to `deflateFrames` landing
   default-off behind its negotiation and flipping after soak, and to HTTP
   `compress()` landing independently?

---

## Finding 1: the transact reply is the echo

**Question.** A fresh-space deploy uploads ~1.05 MB and downloads ~1.6 MB.
The working theory was that watched cache cells echo the client's writes
back. What actually echoes?

**Answer.** Not the watch system — the server already excludes a session's
own accepted writes from watch fan-out (dirty-origin tracking,
`packages/memory/v2/server.ts:3214-3225`; normative in
`docs/specs/memory-v2/04-protocol.md:1001-1004`). The echo is the **transact
reply**: `Server.transact` returns the whole `AppliedCommit` with every
document body verbatim (`server.ts:2292-2296`; bodies attached at
`packages/memory/v2/engine.ts:5404-5413`), not even schema-interned
(`sync-schema-table.ts:183-192` only compresses `sync` frames). The client
reads exactly one field: `applied.seq`
(`packages/runner/src/storage/v2.ts:4465-4490`).

**Evidence.** ~961 KB of reply per fresh-space deploy — 62% of the download,
deterministic across nine runs. A further 105–548 KB comes from
`session.watch.add`'s unconditional initial sync of docs the client just
wrote; the 443 KB spread is a real registration-vs-apply race (adding three
log lines flipped every run to the cheap side). Two client-side suppression
prototypes were built and measured: a schema-less pre-sync changed nothing;
pre-registering recursive selectors cost +15 KB upload for zero saving. The
reply bytes are on the wire before the client can decline them — the fix is
server-side (P1), with one spec caveat (Q1).

## Finding 2: server apply is fast; the event loop is the bottleneck

**Question.** On Rapids, the 645 KB bootstrap transact's round trip took
~19.5 s, and link transport explains only ~2 s. Where do ~17 s go on the
server?

**Answer.** Not in applying the commit. With transact timing added to the
server's slow-query recorder (a gap — it covered watch/query operations but
not `transact`), apply measured **8.6–10.6 ms** in every configuration:
pristine store, store also hosting a copy of the 2.5 GB Topics space, engine
pre-loaded, and under concurrent traffic. The "big neighbor slows apply"
hypothesis is falsified. The seconds live in **queueing ahead of transact**:
the server is single-threaded, and `session.watch.add` on the 2.5 GB space
runs 1.8–2.0 s of synchronous graph traversal (`trackGraph`,
`packages/memory/v2/query.ts:283`) that blocks every connection's frames.

**Evidence.** One concurrent `cf piece ls` against the big space inflated an
unrelated fresh-space deploy from 2.2 s to 4.75 s while that deploy's own
transact still measured 10.7 ms. Traversal cost is depth-driven, not
watch-count-driven: a 58-watch call cost 1.8 s where a 2,295-watch call cost
389 ms. Current instrumentation cannot see the queueing because timing starts
after dequeue — hence P3's `queued = start − arrival` field, which on Rapids
should account for the tail in production logs, and P4 as the fix.

## Finding 3: compression — native impossible, app-level works

**Question.** The payloads gzip 9–23× (bootstrap commit 645 KB → 68 KB; an
8.8 MB read-set commit → 379 KB). Can the WebSocket compress them?

**Answer.** Not natively: on Deno 2.9.4 the client never offers
`Sec-WebSocket-Extensions`, the server ignores offers, and a byte-counting
probe measured 1.00× raw bytes on the wire — so
`packages/memory/v2/schema-table-links.ts:33`'s assumption that "transport
compression absorbs" inline-schema repetition is false in production. A
174-line app-level prototype makes it true: a `deflateFrames` flag in the
existing `hello` negotiation; compressed frames are binary WS messages and
plain frames stay text, so mixed-version peers fall back by construction
(pinned by tests); `CompressionStream("deflate-raw")` keeps it browser-safe;
a FIFO codec queue preserves commit ordering; 4 KB threshold with
never-inflate fallback.

**Evidence.** Fresh-space deploy on the capped testbed: 1.02 MB → 153 KB up,
1.48 MB → 201 KB down (7.0× / 7.7×), reproducible to 0.3%, no measurable CPU
delta. Review attention belongs on the frame-ordering queue. Related quick
win: HTTP responses are entirely uncompressed today — including the 4.6 MB
shell bundle — and hono's `compress()` slots in at
`packages/toolshed/lib/create-app.ts:32` (P6; verify the WS upgrade route and
static-bundle interaction).

## Finding 4: publish batching is a dead end; preamble overlap is not

**Question.** The compiled module set publishes as multiple serialized
transacts, and a cross-space home probe runs serially before the source
fetch. Collapse both?

**Answer.** The chunked publish is deliberate, and batching it buys nothing.
Chunks are 4 modules per commit with the entry module pinned last
(`packages/runner/src/compilation-cache/cell-cache.ts:1450`, `:1519-1522`) so
that a session killed mid-write leaves a clean cache miss — the
all-or-nothing shape is what caused the estuary first-open outage (#5094). A
single-transaction prototype (3 transacts → 1) removed exactly two round
trips and delivered **zero net wall time** on the capped link: the saving was
re-spent on downlink contention in the next commit's conflict retry, and it
vanished only on an uncapped link. The publish is bytes-bound. Abandoned.
The preamble overlap — home probe concurrent with fetching the default
source, speculation discarded in the rare custom-URL case — is a clean
**~1.0 s (6.5%) win**, semantics preserved. Speculating through the *compile*
as well measured identical and is strictly riskier; fetch-only is the shape
to land (P5).

**Evidence.** Nine-condition measurement matrix in the batching agent's
report (baseline n=3, each variant n≥2, flags-off control reproducing
baseline; uncapped runs isolating the round-trip term). Three new tests cover
the previously untested custom-URL branch, including a rejecting speculative
fetch.

---

## Appendix: the baseline that motivated the experiments

`packages/patterns/dice.tsx` (41 lines, one handler), fresh CLI process per
operation, wall seconds:

| Operation | local | Rapids fresh space | Rapids existing space | Estuary fresh space |
| --- | ---: | ---: | ---: | ---: |
| deploy (`piece new`) | 3.4 | 44.6 | 10.4 | 36.6 |
| `get value` (narrow read) | 0.5 | 3.3–3.9 | 3.3 | 3.9–4.1 |
| `call roll` | 0.8–1.4 | 8.3–8.7 | 8.3 | 8.5 |
| `verbs` | 0.8–2.2 | 7.9–8.2 | 8.0 | 8.3–8.8 |

Profile freshness is irrelevant (a fresh identity's home space is one
420-byte commit); the cost is per *space*: `ensureDefaultPattern`
(`packages/piece/src/ops/pieces-controller.ts:491-621`) has each client
fetch the canonical system pattern from the server, compile it, and publish
~1 MB of source plus compiled artifacts into every new space. A narrow read
is structurally healthy (3 KB up / 39 KB down, zero commits) but pays a
serial session/manager preamble for a 16 ms read; `call` and `verbs` load
~760 KB of graph in 16 dependent waves first. Link at measurement time:
190 ms RTT, ~0.59 MB/s up, 1.0–1.6 MB/s down, TLS ~0.57 s per connection.

## Artifacts and reproduction

- Prototype diffs (uncommitted) attached to Linear CT-1963: `echo.diff`,
  `batching.diff`, `server-timing.diff`, `compression.diff`,
  `echo-failed-prototypes.diff`.
- Testbed: `scripts/delay-proxy.ts` (190 ms / 600 KB/s — Rapids' measured
  rates) in front of a pristine or rehearsal-clone toolshed;
  `CF_CLI_TRACE_TIMINGS=1` for phase splits, `CF_WS_SIZE_LOG=1` for
  per-message wire sizes. Method detail:
  [`topics-performance-testbed-2026-08-06.md`](topics-performance-testbed-2026-08-06.md).
- Prior evidence:
  [`topics-performance-investigation-2026-08-06.md`](topics-performance-investigation-2026-08-06.md)
  and the Topics-side plan at
  [`../plans/topics-performance-improvement.md`](../plans/topics-performance-improvement.md).
