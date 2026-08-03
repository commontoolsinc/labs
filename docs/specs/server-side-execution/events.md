# v2 detail: events — the client's computational commit

Normative spec for Phase 3 (D-v2-1). Assumes
[README.md](README.md) §3.6 and [serving-loop.md](serving-loop.md).

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

- Event machinery: `packages/runner/src/scheduler/events.ts`
  (`queueSchedulerEvent`, `addSchedulerEventHandler`,
  `SchedulerEventQueueState`), durable identity in
  `packages/runner/src/scheduler/event-identity.ts`, preflight in
  `event-preflight-dependencies.ts`. The server-side handler run reuses
  this machinery inside the SpaceServer's runtime — do not build a second
  event executor.
- Handler registration rides the SpaceServer's graph-structure load
  for demanded values and queued events (serving-loop.md §1 — no
  piece-start step); `addSchedulerEventHandler` is already the hook.

## 1. The event, as data

An event is an **authored append to a stream document**:

```jsonc
// committed by the client session, ordinary authored commit
{
  "stream": <entity link to the stream doc>,
  "eventId": <durable id from event-identity>,     // client-minted
  "payload": <JSON>,                                // see §3
  "firedAt": { "session": <sessionId>, "clientSeq": n }
}
```

Admission (protocol.md §2): append authority on the stream doc + CAS.
Nothing about the event says or implies "I ran something."

## 2. Lifecycle, end to end

```
client                          server (SpaceServer)
------                          --------------------
handler fires
├─ capture payload (§3)
├─ commit event append ────────► subscription delivers commit
├─ speculative echo:            ├─ classify: event-append
│  run handler + graph          ├─ enqueue via facade.queueEvent
│  on the overlay               ├─ wave: handler runs AUTHORITATIVELY
│  (speculation.md)             │  (writes = ordinary in-memory writes)
│                               ├─ derivations run to fixpoint
│                               └─ ONE derived commit, carrying
│                                  consequenceOf: [eventId...] and the
◄──────────────────────────────────watermark; push to subscribers
└─ reconcile: overlay entries
   for eventId retire; rendered
   state now authoritative
```

- Server-originated events (`stream.send()` from a served computation, or
  piece-to-piece) enter at "enqueue" with `firedAt.session = server` and
  are otherwise identical. One path, two producers. When the target
  stream lives in ANOTHER space, the append travels via the outbox as an
  authored commit — the only cross-space mutation (protocol.md §2b).
- Ordering: per stream, events process in commit-seq order. Across
  streams in one space, wave order (arrival). No global ordering claim
  beyond the space's commit sequence — same as today.
- **Batching is at the COMMIT level only (D-v2-2, ruled 2026-08-02)**:
  the wave commits once, at scheduler idle, with `consequenceOf`
  listing every event processed. Handler-visible semantics are
  UNCHANGED from today's client: the scheduler recomputes a dirty
  computed input on demand before the handler that reads it runs
  (`event-preflight-dependencies.ts:246-248` — preflight recomputes an
  input that is invalid OR has never run, so the lazy-computed case is
  literally in the code; CT-1795's staleness park is an extra gate on
  top) — the common case being not rapid-fire but a lazy computed
  nothing has pulled yet, which the handler must and does see fresh.
  An earlier proposal to drain all handlers ahead of derivations
  (handlers reading last-wave state) was REJECTED by the owner: events
  drain as part of regular execution —
  the loop is simply not idle until all events are processed. Rapid-
  fire efficiency falls out of pull-based laziness (superseded
  intermediates are never demanded, so never computed), with the single
  derived commit as the only batching.
- Server enqueue goes through the scheduler facade (`facade.queueEvent`
  — the wake-shaping entry point), never raw `queueSchedulerEvent`, so
  server-enqueued events get the same shaping as client ones.
- The inherited backlog collapse (`events.ts:266-321`) would
  last-wins-coalesce DURABLE intents; under the flag, collapse is
  DISABLED for durable-id stream events — backpressure is shaped at the
  binding layer instead (README §3.8). (Ledger L8: the owner may yet
  prefer collapse that lists every collapsed id in `consequenceOf`.)

## 3. Payload capture rule

Handler inputs are **explicit**: the event payload plus cells the handler
reads. Any client-only ephemeral value the handler's semantics need
(viewport, selection, local time-of-fire) MUST be captured into the
payload at fire time by the binding layer. The server-side run reads
payload + cells only. A handler reaching for ambient client state is a
pattern bug; the ts-transformers lint for this is a Phase 3 follow-up,
not a blocker. Handlers whose consequences provision spaces
(`.inSpace`) MUST additionally be deterministic given payload + cells —
no clock, no randomness — because replay convergence depends on
re-deriving the same ids (protocol.md §2b); that lint trails with the
ambient-state one.

## 4. Idempotency (exactly-once consequences)

- The derived commit that carries a handler's consequences records
  `consequenceOf: [eventId...]` in its commit metadata.
- Per stream, the server tracks `eventWatermark` = seq of the last event
  whose consequences committed — a field ON the stream doc, written in
  the same derived commit (never its own commit).
- Reprocessing rule (recovery, serving-loop.md §6): an event replays iff
  its stream seq > `eventWatermark`. At-or-below: skip, count
  `skippedIdempotent`.
- The consequence commit and the watermark advance are atomic (same
  transaction), so there is no window where an event is both consumed and
  replayable. Under a mid-wave conflict they rebase TOGETHER into the
  retried commit, never separately (serving-loop.md §3d).
- **The dedupe horizon**: admission enforces `eventId` uniqueness only
  among stream entries with seq > `eventWatermark` (protocol.md §2);
  duplicates of an event at or below it are rejected by the processing
  watermark instead — the replay rule above skips them, counted
  `skippedIdempotent`. Stream entries at or below `eventWatermark` MAY
  therefore compact (the store-growth lesson: a consumed intent needs
  no eternal stream copy to keep dedupe sound).
- Cascade sends minted inside a handler attempt get fresh ids per
  attempt (`event-identity.ts:5-9`); harmless under exactly-once,
  because only the committing attempt's cascades escape the wave.
- Today's receipt-cell exactly-once (`commitPreconditions`, on by
  default) is SUBSUMED by `eventWatermark` under the flag; the two
  mechanisms MUST NOT be active for the same event
  (runtime-mapping.md N26).

FORBIDDEN: a processed-events table; per-event acks from clients;
handler-run provenance records.

## 5. Failure semantics

- Handler throws server-side: commit NO consequences; write the existing
  handler-error surface (same shape clients show today) as the derived
  commit for that event, advance `eventWatermark` past it (an error IS
  the consequence — else a poison event wedges the stream), push.
- Client offline at fire time: events queue client-side as unacked
  authored commits and submit on reconnect in fired order (Q1's default;
  owner may refine). The speculative echo stands meanwhile; reconciliation
  is ordinary (speculation.md §4).
- Duplicate submission (client retry after ambiguous network outcome):
  the append is CAS-guarded by `eventId` uniqueness above the dedupe
  horizon (§4) — a duplicate of a not-yet-consequenced event is
  rejected at admission; a duplicate of an already-consequenced one
  falls to the processing watermark and is skipped
  (`skippedIdempotent`).

## 6. UI-binding writes (for contrast, and to stop scope creep)

`$value` bindings and widget edits are authored doc writes under existing
ACL + CAS (README §1). They are NOT events, do not carry eventIds, do not
touch `eventWatermark`, and need no changes in v2. To the serving loop
they are pure dirtiness inputs. Do not "unify" them with events; the
unification is D-v2-1's non-goal — they may migrate someday as a product
choice.

## 7. What the client loses, explicitly

Under the flag, the client handler path commits **only the event**. The
handler's writes apply to the speculation overlay, never to a storage
transaction. Deleting the client's handler-write commit path is a Phase 3
task, and its absence is what makes admission target+principal-only. If
some test needs a client handler write to commit, the test is asserting
v1 behavior — fix the test.
