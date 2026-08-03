# v2 detail: protocol — commit classes, admission, push, watermark

Normative. Assumes [README.md](README.md); details Phases 1–4 surface
between client, memory server, and SpaceServer.

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

- Memory server: `packages/memory/v2.ts`, toolshed mount
  `/api/storage/memory` (`packages/toolshed/routes/storage/memory/`).
- Client storage stack: `packages/runner/src/storage/` (`interface.ts`,
  `extended-storage-transaction.ts`, `query.ts`, `reactivity-log.ts`).
- Store tables: `commit`, `revision`, `head`, `branch`,
  `execution_lease` (engine-v3).

## 1. Commit classes

Every commit carries a `class` in its metadata. Three values, closed set:

| class | producer | contents |
| --- | --- | --- |
| `authored` | any authorized session | doc writes (UI bindings, widget edits) or event appends (events.md §1) |
| `derived` | the space's SpaceServer (lease holder) | derivation results, watermark advance, `consequenceOf` |
| `system` | memory server itself | space bootstrap, authorization changes — pre-existing, unchanged |

FORBIDDEN: a fourth class; per-class subtypes that alter admission;
clients producing `derived` (there must be no client code path that can
even construct one).

## 2. Admission, the whole table

| commit class | checks, in order |
| --- | --- |
| `authored` doc write | session authenticated → write authority on doc/path (existing ACL) → CAS on base revision |
| `authored` event append | session authenticated → append authority on stream doc → `eventId` unique on stream (CAS) |
| `derived` | producer holds the live `execution_lease` for the space (one equality check) → CAS |
| `system` | unchanged from today |

That is the ENTIRE admission surface. No scope reasoning, no read-set
validation, no certificates: no commit ever asserts that an execution
happened elsewhere. If an admission question cannot be answered by
(target, principal, lease, CAS), the design is drifting — stop.

## 2b. Cross-space writes

The storage layer already enforces the load-bearing rule (anchor:
`packages/runner/src/storage/interface.ts` `writer(space)` — a
transaction FAILS if a writer for a different space was already opened
on it): **one transaction writes one space.** Reads cross freely
(serving-loop.md §3b; cross-space label metadata flows with them). v2
keeps that invariant and adds the class discipline:

| crossing | mechanism |
| --- | --- |
| read a foreign doc | free — logged read + server-internal wake (§3b) |
| derive FROM foreign state | home derivation reading foreign inputs; result commits HOME |
| mutate a foreign space | **an event append to a foreign stream — the ONLY cross-space mutation** |
| `derived` commit into a foreign space | FORBIDDEN — SpaceServer(B) is B's only deriver; A never derives into B |
| client authored writes to several spaces | unchanged from today: separate per-space commits, per-space ACL + CAS |

The event append crosses as an ordinary `authored` commit under the
piece's append capability, carried by the OUTBOX (serving-loop.md §5):
at-least-once, deduped by `eventId` at the target's admission, FIFO per
(source wave → target stream). The target's SpaceServer processes it
like any event. This matches the codebase's own convention — patterns
already mutate cross-space through exported streams — and it is now the
rule, not a style: a server action tx that opens a foreign-space writer
is a runtime error naming this section.

**Atomicity, stated plainly:** nothing spanning two spaces is atomic —
not today, not in v2. A wave is per-space; cross-space influence is
asynchronous (reads/wakes inward, events outward). What v2 adds is that
the non-atomic boundary is EXPLICIT and carries defined failure
semantics: the outbox retries the append, the eventId dedupes it, and
the target's `eventWatermark` makes processing exactly-once.

## 3. Subscription and push

- Clients subscribe to docs/queries as today
  (`packages/runner/src/storage/query.ts` path). The SpaceServer
  subscribes to the whole space's accepted-commit feed from a seq.
- **Push priority** (Phase 6 hardening, but the contract is fixed now):
  when flushing a batch to a client socket, `derived` commits touching
  docs that client subscribes to go first; everything else follows.
  Bookkeeping MUST NOT ride the commit stream at all (lease renewals are
  table updates; watermarks piggyback on derived commits), so in practice
  priority is about big authored blobs vs small derived values.
- Self-echo: SpaceServer skips its own `derived` commits on receipt
  (serving-loop.md §3).

## 4. The watermark

- Definition: `W(space)` = highest seq such that every authored commit
  ≤ W has all its derived consequences committed.
- Carried: in every `derived` commit's metadata (`derivedThrough: W`) and
  in one well-known doc per space (updated in the same transaction; never
  its own commit).
- Client use: "settled" for a client = `W ≥ seq(my last authored
  commit)`. Integration tests MUST wait on this instead of text-polling
  (testing.md §3). Sync indicators read the same signal.
- The watermark is ONE integer per space. Not per-doc, not per-piece, not
  vectorized. If a consumer seems to need a finer watermark, escalate
  before building it.

## 5. The client-effect channel (Phase 4)

Session-scoped, server-computed, client-enacted effects (README §3.7).

- One doc per session at a deterministic path:
  `session/<sessionId>/effects` (exact path constant to be fixed in code;
  one constant, exported once).
- Shape: append-list of
  `{ nonce, kind, args, issuedIn: <derived commit seq> }`;
  v2 ships exactly one kind: `navigate` with
  `args = { target: <entity link> }`.
- The SpaceServer writes intents as part of ordinary derived commits
  (navigateTo's output). The session's client subscribes to its own
  effects doc, enacts, then commits an authored ack write
  `{ ackedNonce }`; the next wave retires acked entries.
- Exactly-once enactment per nonce is the CLIENT's duty (it may enact
  optimistically from speculation, then reconcile by nonce — navigation
  is reversible). Reload between intent and ack: on resubscribe the
  client sees unacked intents and enacts them; nonces make re-enactment
  detectable.
- Effects docs are session-lifetime: retired with the session. Nothing
  global, nothing cross-session.

FORBIDDEN: new kinds without a spec edit here; a push channel outside the
doc/subscription model; server-side retries of enactment.

## 6. Streaming (deferred, boundary fixed)

Settled-result-only commits are the v2 baseline. If/when LLM partials
ship, they use an ephemeral session channel OUTSIDE the commit stream —
partials never become commits, never touch the watermark, never wake the
serving loop. `stream-data` stays disabled (README §3.5).

## 7. Wire-shape discipline

- Commit metadata additions in v2, complete list: `class`, `holder`
  (derived only), `derivedThrough` (derived only),
  `consequenceOf` (derived only), `eventId`/`firedAt` (event appends).
  Anything further needs a spec edit here first.
- All metadata is small and fixed-shape. The v1 failure mode — 130 KB of
  serialized read links per record — is structurally impossible if this
  list is respected. A metadata field that scales with graph size is
  FORBIDDEN.
- Writes inside a `derived` commit keep PER-ACTION provenance for CFC
  label purposes (serving-loop.md §3c): the commit is a transport batch,
  never a label boundary.
