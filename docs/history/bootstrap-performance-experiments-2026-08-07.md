---
status: historical
created: 2026-08-07
archived: 2026-08-07
reason: "Experiment record: hello-world bootstrap baseline and four prototyped fixes, the evidence behind the CT-1963 proposals."
---

# Fresh-space bootstrap: baseline and four experiments

## Purpose

One document for the owners of the storage and piece layers. It records what
deploying and using a minimal pattern actually costs in each environment, why,
and what four prototyping experiments established about the candidate fixes —
including two negative results that close off approaches that looked obvious.
Every number is reproducible on the WAN-emulation testbed
([`topics-performance-testbed-2026-08-06.md`](topics-performance-testbed-2026-08-06.md)
describes the instrument; `scripts/delay-proxy.ts` plus a rehearsal-clone or
pristine toolshed).

The experiments were run by four isolated agents, each in its own worktree
with its own server, store, and emulated link (190 ms RTT, 600 KB/s — the
Rapids link's measured rates). Their full uncommitted diffs are attached to
Linear CT-1963.

## The baseline: hello world, measured

`packages/patterns/dice.tsx` (41 lines, one handler), fresh CLI process per
operation, wall seconds:

| Operation | local | Rapids fresh space | Rapids existing space | Estuary fresh space |
| --- | ---: | ---: | ---: | ---: |
| deploy (`piece new`) | 3.4 | 44.6 | 10.4 | 36.6 |
| `get value` (narrow read) | 0.5 | 3.3–3.9 | 3.3 | 3.9–4.1 |
| `call roll` | 0.8–1.4 | 8.3–8.7 | 8.3 | 8.5 |
| `verbs` | 0.8–2.2 | 7.9–8.2 | 8.0 | 8.3–8.8 |

Identity/profile freshness is irrelevant (a fresh identity's home space is one
420-byte commit); the cost is per *space*. The fresh-space deploy is dominated
by `ensureDefaultPattern`
(`packages/piece/src/ops/pieces-controller.ts:491-621`): the client fetches
the canonical system pattern from the server, compiles it, and publishes
source plus compiled artifacts (~1 MB) into the new space. Wire totals per
fresh-space deploy: ~1.05 MB up, ~1.6 MB down, ~21 dependent watch waves, six
session opens. A narrow read is structurally healthy (3 KB up / 39 KB down,
zero commits) but pays a serial preamble (health, session, manager sync) for
a 16 ms read. Anything that runs the piece (`call`, `verbs`) loads ~760 KB of
graph in 16 dependent waves first.

Link characterization at measurement time: RTT ~190 ms, TLS ~0.57 s per
connection, download 1.0–1.6 MB/s, upload a consistent 0.59 MB/s. Nothing on
any route is compressed.

## What the four experiments established

### 1. The transact verdict is the echo — not the watch system

Question: why does a fresh-space deploy download roughly as much as it
uploads (~1.1–1.6 MB down for ~1.05 MB up)?

Finding: the watch system was presumed guilty and is innocent — the server
already suppresses a session's own writes from watch fan-out (dirty-origin
tracking, `packages/memory/v2/server.ts:3214-3225`, normative in
`docs/specs/memory-v2/04-protocol.md:1001-1004`). The dominant echo is the
**transact verdict**: `Server.transact` returns the whole `AppliedCommit`,
document bodies verbatim (`server.ts:2292-2296`; bodies attached at
`packages/memory/v2/engine.ts:5404-5413`), not even schema-interned
(`sync-schema-table.ts:183-192` bails on non-`sync` frames). The client
provably reads **one integer** from it — `applied.seq`
(`packages/runner/src/storage/v2.ts:4465-4490`). That is ~961 KB, 62% of the
deploy's download, deterministic. The rest of the echo is `session.watch.add`'s
unconditional initial full sync of docs the client just wrote (105–548 KB —
the 443 KB spread is a real registration/apply race, demonstrated by flipping
it with three added log lines).

Client-side suppression was prototyped twice and measured dead: a schema-less
pre-sync changed nothing; pre-registering recursive selectors cost +15 KB
upload for zero download saving. The verdict bytes are on the wire before the
client can decline them. **The viable fix is server-side: strip document
bodies from the transact verdict at the response boundary** (~one line plus a
test update at `packages/memory/test/v2-server.test.ts:1458-1474`). One design
caveat for the owners: the protocol spec reserves a post-apply `document` on
patch revisions as the writer's channel for merge-rebased truth; it is not
implemented in this tree, and a blanket strip would foreclose it.

Secondary findings: the protocol has **no unwatch message** (watch sets are
append-only per session, shrink only by full `session.watch.set`
recomputation), and content-addressed compile-cache docs arguably never need
watches — one-shot `session.queryGraph` exists and the runner already uses it
for ACL bootstrap.

### 2. Batching the publish does not pay; overlapping the preamble does

Question: the compiled module set publishes as multiple serialized transacts,
and the home-space `defaultAppUrl` probe runs serially before the source
fetch — collapse both?

Finding: the chunked publish is **deliberate** — 4 modules per commit with the
entry module pinned last (`cell-cache.ts:1450`, `:1519-1522`), so a session
killed mid-write leaves a clean cache miss instead of a corrupt entry; one
all-or-nothing commit is the shape that caused the estuary first-open outage
(#5094). A single-transaction prototype worked mechanically (3 transacts → 1)
and delivered **zero net wall time** on the capped link: the two saved round
trips were re-spent on downlink contention in the next commit's conflict
retry. On a bandwidth-capped link the publish is bytes-bound, not
round-trip-bound. **Abandoned**, and the durability property stays.

The parallel preamble — running the home probe concurrently with fetching the
default source, discarding the speculative fetch in the rare custom-URL case —
is a clean **~1.0 s (6.5%) win** with semantics preserved and three new tests
covering the previously untested custom-URL branch. Speculating through the
*compile* as well measured identical and is strictly riskier; fetch-only is
the right shape. **Proposed.**

### 3. Server transact apply is exonerated; the cost is event-loop blocking

Question: on Rapids, the 645 KB bootstrap transact's round trip took ~19.5 s
of which ~17 s was attributed to the server. What is the server doing?

Finding: **nothing, quickly.** With transact timing added to the server's
slow-query recorder (it covers watch/query operations but not `transact` —
an instrumentation gap), the 645 KB / 19-op commit applies in **8.6–10.6 ms**
in every configuration: pristine store, store also hosting a copy of the
2.5 GB Topics space, engine loaded, even under concurrent traffic. The
big-neighbor hypothesis is falsified.

What the experiment found instead: **head-of-line blocking on the
single-threaded server.** `session.watch.add` on the 2.5 GB space runs
1.8–2.0 s of synchronous graph traversal (`trackGraph`,
`packages/memory/v2/query.ts:283`), blocking every connection's frames.
Demonstrated directly: one concurrent `cf piece ls` against the big space
inflated an unrelated fresh-space deploy from 2.2 s to 4.75 s while that
deploy's own transact still measured 10.7 ms. The Rapids ~17 s is consistent
with queueing delay ahead of transact — other sessions' multi-second
synchronous watch work on big spaces — which current instrumentation cannot
see because timing starts after dequeue. The proposed next increment: stamp
frame arrival in `Connection.receive` and record `queued = start − arrival`;
on Rapids that single number should account for the gap in production logs.
The eventual fix target is `session.watch.add` traversal on large spaces
(yield between traversals or bound the batch); notably a 58-watch call cost
1.8 s while a 2,295-watch call cost 389 ms — the driver is traversal depth
over the big graph, not watch count.

### 4. Transport compression: native is unavailable; an app-level flag works

Question: the payloads compress 9–23× (bootstrap commit 645 KB → 68 KB gz;
an 8.8 MB read-set commit → 379 KB) — can the transport compress?

Finding: Deno 2.9.4 has **no permessage-deflate on either side**, proven
empirically (the client sends no `Sec-WebSocket-Extensions` offer; the server
ignores offers; a byte-counting probe measured 1.00× raw bytes on the wire).
The `schema-table-links.ts:33` assumption that "transport compression
absorbs" inline-schema repetition is false in production.

A 174-line app-level prototype makes it true: a `deflateFrames` flag in the
existing `hello` negotiation, compressed frames as binary WS messages (text =
uncompressed, so mixed-version peers fall back by construction, pinned by
tests), `CompressionStream("deflate-raw")` so it works in browsers, a FIFO
codec queue preserving the protocol's commit ordering, and a 4 KB threshold
with never-inflate fallback. Measured: **7.0× less upload / 7.7× less
download** on the fresh-space deploy (1.02 MB → 153 KB up; 1.48 MB → 201 KB
down), reproducible to 0.3%, no measurable CPU delta. Reviewer attention
belongs on the frame-ordering queue. Separately, HTTP responses are entirely
uncompressed today — including the 4.6 MB shell bundle — and hono's
`compress()` middleware slots in at `packages/toolshed/lib/create-app.ts:32`
(verify it skips the WS upgrade route and the static bundle interaction).

## The revised cost model

A cold interaction's cost decomposes into four terms, now each with an owner-
shaped fix:

1. **Bytes** — uncompressed, highly repetitive payloads on a ~0.6 MB/s
   uplink; and 62% of the download is a verdict the client discards.
   → verdict strip + `deflateFrames` + HTTP gzip.
2. **Structure** — serial dependent waves; the preamble serializes a
   cross-space probe ahead of everything. → parallel preamble now; CT-1959
   (schema-rooted sync) for the general wave count.
3. **Server event loop** — seconds-long synchronous graph traversals block
   every connection; this, not apply cost, is the Rapids-specific tail.
   → queue-wait instrumentation, then yield/bound `session.watch.add`.
4. **Bootstrap design** — every space carries its own copy of the identical
   compiled system pattern, uploaded by each client. Untouched by the
   experiments; the parked redesign (server-seeded genesis) remains the
   floor-setter.

## Proposals, ranked

| # | Change | Size | Measured or projected effect | Status |
| --- | --- | --- | --- | --- |
| P1 | Strip document bodies from the transact verdict (server response boundary) | ~1 line + test | −961 KB download per fresh-space deploy, deterministic | needs owner ruling on the reserved patch-rebase channel |
| P2 | `deflateFrames` app-level WS compression | 174 lines, prototyped + tested | 7× wire reduction both ways, no CPU cost | ready for review; scrutinize FrameOrder |
| P3 | Transact + queue-wait slow-query instrumentation | small, mostly written | converts the Rapids tail into a logged number | shippable now |
| P4 | Yield/bound `session.watch.add` traversal on large spaces | needs design | removes multi-second event-loop stalls for every connected client | the Rapids whale |
| P5 | Parallel preamble (fetch mode) | small, prototyped + 3 tests | −1.0 s per fresh-space deploy (grows with real WAN) | ready for review |
| P6 | HTTP `compress()` on toolshed | ~1 line + route checks | 4.6 MB shell bundle → ~1 MB; all HTTP routes | quick win, unwired |
| — | Single-transaction cache publish | — | zero net win; forfeits #5094 crash durability | **abandoned, do not revisit** |
| — | Client-side echo suppression | — | two variants measured: no effect / net worse | **abandoned; fix is server-side (P1)** |

## Questions for the owners

1. **P1:** is the spec's reserved post-apply `document` on patch revisions
   (merge-rebased truth) planned? If yes, the verdict strip should exempt
   patch revisions; if no, the strip is unconditional and the spec line
   should be updated in the same change.
2. **Watches on immutable docs:** content-addressed compile-cache entries
   never change under their key. Should the cache read path move to one-shot
   `graph.query`, and more generally, should the protocol grow an unwatch (or
   `watch.add` without initial sync for docs the client holds at seq)?
3. **Event loop:** is yielding inside `trackGraph` acceptable
   (re-entrancy/consistency assumptions during traversal), or is bounding the
   per-call batch the safer shape?
4. **Bootstrap design (parked, but the floor):** must each space durably
   carry its own copy of the compiled system pattern, or can genesis be
   server-seeded / globally content-addressed? What does CFC provenance
   require here?
5. **Compression rollout:** any objection to negotiated `deflateFrames`
   landing default-off, flipped after soak — and to HTTP `compress()`
   landing independently?

## Artifacts

- Agent diffs (uncommitted prototypes and instrumentation): attached to
  Linear CT-1963 as `echo.diff`, `batching.diff`, `server-timing.diff`,
  `compression.diff`, plus `echo-failed-prototypes.diff` for the two
  measured-dead suppression attempts.
- Prior evidence: [`topics-performance-testbed-2026-08-06.md`](topics-performance-testbed-2026-08-06.md)
  (storage anatomy, cost ladder, transfer composition) and
  [`topics-performance-investigation-2026-08-06.md`](topics-performance-investigation-2026-08-06.md)
  (the original Rapids snapshot evidence).
- The improvement plan tracking the Topics-side stack:
  [`../plans/topics-performance-improvement.md`](../plans/topics-performance-improvement.md).
